/** Room audio uses the existing authenticated SFU; speaking intent is local. */
export function createRoomVoice({sdk=null,loadSdk=()=>import('../vendor/livekit-client-2.22.4.esm.mjs'),transport,onChange=()=>{},window:win=globalThis.window,document:doc=globalThis.document}={}){
 let epoch=0,gesture=0,room=null,terminal=null,joining=false,track=null,micTask=null,mode='off',speaking=false,mic='prompt',message='',playbackBlocked=false,destroyed=false,timer=null,pulse=null,removeTrackEnded=()=>{};
 const peers=new Map(),muted=new Set(),bindings=[],audioBindings=new Map(),audioTracks=new Map();
 let captureInterrupted=false,captureNeedsRepair=false,systemInterrupted=false,openEstablished=false,repairTask=null;
 let listeningAuthorized=false,playbackTask=null,playbackRecoveryTried=false,foregroundRecoveryDone=false,observedContext=null,removeContextState=()=>{};
 const alive=g=>!destroyed&&g===epoch;
 const state=()=>({supported:typeof win.RTCPeerConnection==='function'&&!!win.navigator.mediaDevices?.getUserMedia,joined:!!terminal,joining,speaking,mode,mic,message,captureInterrupted:mode!=='off'&&captureInterrupted,systemInterrupted,audioRecovering:!!repairTask,playbackBlocked,playbackRecovering:!!playbackTask,
  peers:[...peers.values()].map(p=>({id:p.id,playerId:p.playerId,connected:true,speaking:p.speaking,muted:muted.has(p.playerId)}))});
 const emit=()=>{if(!destroyed)onChange(state());};
 const outputs=()=>[...peers.values()].flatMap(peer=>muted.has(peer.playerId)?[]:[...peer.elements]);
 function outputBlocked(r){const elements=outputs(),contextState=r.audioContext?.state;
  if(contextState==='suspended'||contextState==='interrupted'||contextState==='closed')return true;
  if(elements.length)return elements.some(audio=>audio.paused===true||audio.ended===true||!!audio.error);
  return contextState==='running'?false:!r.canPlaybackAudio;
 }
 function finishPlayback(record,ok){if(playbackTask!==record)return;playbackTask=null;win.clearTimeout(record.timer);win.clearTimeout(record.clockTimer);record.resolve(ok);
  if(alive(record.g)&&room===record.r){playbackBlocked=!ok;if(ok){listeningAuthorized=true;playbackRecoveryTried=false;}emit();}
 }
 function recoverPlayback({explicit=false,foreground=false,verifyClock=false,rebind=false}={}){
  const g=epoch,r=room;if(!r||!terminal||joining||destroyed||doc.hidden||systemInterrupted)return Promise.resolve(false);
  if(playbackTask){if(verifyClock){playbackTask.verifyClock=true;playbackTask.allowRebind||=rebind;}return playbackTask.promise;}
  // A rejected interruption recovery while the window was unfocused must not
  // spend the next foreground transition's one existing-output retry.
  if(!explicit&&(!listeningAuthorized||(foreground?foregroundRecoveryDone:playbackRecoveryTried)))return Promise.resolve(!outputBlocked(r));
  if(!explicit&&!foreground&&!outputBlocked(r))return Promise.resolve(true);
  if(foreground)foregroundRecoveryDone=true;playbackRecoveryTried=true;
  let resolve;const record={g,r,timer:null,clockTimer:null,verifyClock,allowRebind:rebind,rebound:false,promise:new Promise(done=>{resolve=done;}),resolve:null};record.resolve=resolve;playbackTask=record;
  record.timer=win.setTimeout(()=>finishPlayback(record,false),1000);emit();
  const valid=()=>playbackTask===record&&alive(g)&&room===r;
  const sample=()=>{
   const values=outputs().filter(a=>a.srcObject&&Number.isFinite(a.currentTime)).map(a=>({node:a,time:a.currentTime,context:false}));
   if(r.audioContext&&Number.isFinite(r.audioContext.currentTime))values.push({node:r.audioContext,time:r.audioContext.currentTime,context:true});
   return values;
  };
  const run=()=>{
   const samples=sample(),jobs=[];
   try{
    // Never use global startAudio here: it unmutes deliberately muted peers.
    if(r.audioContext&&r.audioContext.state!=='closed')jobs.push(Promise.resolve(r.audioContext.resume()));
    for(const audio of outputs())jobs.push(Promise.resolve(audio.play()));
   }catch(error){jobs.push(Promise.reject(error));}
   Promise.allSettled(jobs).then(results=>{
    if(!valid())return;
    if(results.some(result=>result.status!=='fulfilled')||outputBlocked(r)){finishPlayback(record,false);return;}
    if(!record.verifyClock){finishPlayback(record,true);return;}
    let checks=0;const checkClocks=()=>{
     if(!valid())return;checks++;
     const advanced=samples.every(({node,time,context})=>{
      if(context)return r.audioContext===node&&node.currentTime>time+.001;
      return !outputs().includes(node)||node.currentTime>time+.001;
     });
     if(advanced&&!outputBlocked(r)){finishPlayback(record,true);return;}
     // One explicit same-track reattachment, never a new Room/PC or audio graph.
     if(record.allowRebind&&!record.rebound&&outputs().length){
      record.rebound=true;
      try{for(const peer of peers.values())if(!muted.has(peer.playerId))for(const audio of peer.elements){
       const remote=audioTracks.get(audio);if(!remote)continue;
       remote.detach(audio);remote.attach(audio);audio.muted=muted.has(peer.playerId);
      }}catch{finishPlayback(record,false);return;}
      run();
     }else if(checks<3)record.clockTimer=win.setTimeout(checkClocks,180);
     else finishPlayback(record,false);
    };record.clockTimer=win.setTimeout(checkClocks,180);
   });
  };
  run();
  return record.promise;
 }
 function checkPlayback(g,r,{recover=false}={}){if(!alive(g)||room!==r)return;playbackBlocked=playbackTask?.verifyClock?true:outputBlocked(r);emit();if(recover&&playbackBlocked)void recoverPlayback();}
 function observeContext(g,r){const current=r.audioContext;if(!current||observedContext===current)return;removeContextState();observedContext=current;
  const changed=()=>checkPlayback(g,r,{recover:true});current.addEventListener?.('statechange',changed);removeContextState=()=>current.removeEventListener?.('statechange',changed);
 }
 function watchAudio(audio,peer,g,r){const valid=()=>alive(g)&&room===r&&peer.elements.has(audio);
  const paused=()=>{if(valid())checkPlayback(g,r,{recover:true});};
  const playing=()=>{if(valid()){listeningAuthorized=true;checkPlayback(g,r);}};
  const keepMuted=()=>{if(valid()&&muted.has(peer.playerId)&&!audio.muted)audio.muted=true;};
  for(const type of ['pause','ended','error'])audio.addEventListener?.(type,paused);audio.addEventListener?.('playing',playing);audio.addEventListener?.('volumechange',keepMuted);
  audioBindings.set(audio,()=>{for(const type of ['pause','ended','error'])audio.removeEventListener?.(type,paused);audio.removeEventListener?.('playing',playing);audio.removeEventListener?.('volumechange',keepMuted);});
 }
 function removeAudio(peer,audio){peer.elements.delete(audio);audioBindings.get(audio)?.();audioBindings.delete(audio);audioTracks.delete(audio);audio.pause();audio.srcObject=null;audio.remove();}
 function participant(p){let metadata;try{metadata=JSON.parse(p.metadata??'{}');}catch{metadata={};}return {id:p.identity,playerId:metadata.playerId??p.identity};}
 function roster(){if(!room)return;const current=new Set();for(const p of room.remoteParticipants.values()){current.add(p.identity);if(!peers.has(p.identity))peers.set(p.identity,{...participant(p),speaking:false,elements:new Set(),timer:null});}
  for(const [id,p]of peers)if(!current.has(id)){for(const a of [...p.elements])removeAudio(p,a);win.clearTimeout(p.timer);peers.delete(id);}emit();}
 function signal(){if(!room||!terminal)return;try{Promise.resolve(room.localParticipant.publishData(new Uint8Array([speaking?1:0]),{reliable:false,topic:'room-ptt-v1'})).catch(()=>{});}catch{}}
 function silence(){win.clearInterval(pulse);pulse=null;if(track)track.mediaStreamTrack.enabled=false;const wasSpeaking=speaking;speaking=false;if(wasSpeaking)signal();}
 function release(){const changed=mode!=='off'||speaking;mode='off';openEstablished=false;gesture++;if(repairTask)finishRepair(repairTask,false,{cancelled:true});win.clearTimeout(timer);timer=null;silence();if(changed)emit();}
 function enableSpeech(){if(mode==='off'||!track||track.mediaStreamTrack.readyState==='ended'||track.mediaStreamTrack.muted===true||systemInterrupted)return false;
  captureInterrupted=false;captureNeedsRepair=false;track.mediaStreamTrack.enabled=true;speaking=true;if(mode==='open')openEstablished=true;signal();win.clearInterval(pulse);pulse=win.setInterval(signal,750);emit();return true;
 }
 function interruptCapture(){foregroundRecoveryDone=false;playbackRecoveryTried=false;if(repairTask)finishRepair(repairTask,false,{cancelled:true});captureInterrupted=true;if(mode==='hold'||(mode==='open'&&!openEstablished))release();else silence();message='系统正在占用音频，结束听写后可恢复语音。';emit();}
 function resumeExistingCapture(){if(repairTask||systemInterrupted||captureNeedsRepair||track?.mediaStreamTrack.muted===true)return;
  if(track?.mediaStreamTrack.readyState==='live'){captureInterrupted=false;if(mode==='open'&&openEstablished)enableSpeech();else emit();}
 }
 function releaseHold(){if(mode==='hold')release();}
 function clearTrack(acquired){if(track!==acquired)return;removeTrackEnded();removeTrackEnded=()=>{};track=null;}
 function watchTrack(acquired,g,r){
  const raw=acquired.mediaStreamTrack;
  const ended=()=>{
   if(!alive(g)||room!==r||track!==acquired)return;
   if(repairTask?.retiringTrack===acquired&&!repairTask.cancelled){
    // The explicit replacement already owns retirement. Its old ended event
    // must not cancel the newer gesture or unpublish a replacement track.
    silence();clearTrack(acquired);captureInterrupted=true;captureNeedsRepair=true;
    try{Promise.resolve(acquired.mute()).catch(()=>{});}catch{}emit();return;
   }
   release();clearTrack(acquired);captureInterrupted=true;captureNeedsRepair=true;mic='prompt';message='麦克风已停止，点击发言可重试，仍可收听。';emit();
   // SDK end handling may try another device. Mute this retired SDK track first,
   // then unpublish only it from its owning room, never a later microphone.
   try{Promise.resolve(acquired.mute()).catch(()=>{}).then(()=>r.localParticipant.unpublishTrack(acquired)).catch(()=>{});}catch{}
  };
  const interrupted=()=>{if(alive(g)&&room===r&&track===acquired)interruptCapture();};
  const resumed=()=>{if(alive(g)&&room===r&&track===acquired){resumeExistingCapture();void recoverPlayback({foreground:true,verifyClock:true});}};
  raw.addEventListener('ended',ended);raw.addEventListener('mute',interrupted);raw.addEventListener('unmute',resumed);
  removeTrackEnded=()=>{raw.removeEventListener('ended',ended);raw.removeEventListener('mute',interrupted);raw.removeEventListener('unmute',resumed);};
 }
 function leave(reason='已退出语音。'){
  const old=terminal,previous=room;epoch++;release();terminal=null;joining=false;room=null;micTask=null;if(repairTask)repairTask.cancelled=true;repairTask=null;captureInterrupted=false;captureNeedsRepair=false;
  if(playbackTask)finishPlayback(playbackTask,false);removeContextState();removeContextState=()=>{};observedContext=null;listeningAuthorized=false;playbackRecoveryTried=false;foregroundRecoveryDone=false;
  const previousTrack=track;clearTrack(previousTrack);previousTrack?.stop();for(const p of peers.values()){for(const a of [...p.elements])removeAudio(p,a);win.clearTimeout(p.timer);}peers.clear();
  previous?.removeAllListeners();Promise.resolve(previous?.disconnect(true)).catch(()=>{});message=reason;playbackBlocked=false;emit();if(old)Promise.resolve(transport.leave({id:old.id})).catch(()=>{});
 }
 async function join(){if(destroyed||joining||terminal)return !!terminal;if(!state().supported){message='此浏览器暂不支持语音。';emit();return false;}
  const g=++epoch;joining=true;message='正在加入语音…';emit();try{sdk??=await loadSdk();}catch{if(alive(g)){joining=false;message='语音组件暂时未加载，请重试。';emit();}return false;}if(!alive(g))return false;const r=new sdk.Room({adaptiveStream:false,dynacast:false,reconnectPolicy:{nextRetryDelayInMs:()=>null},publishDefaults:{audioPreset:sdk.AudioPresets.speech,stopMicTrackOnMute:false}});room=r;
  r.on(sdk.RoomEvent.ParticipantConnected,roster).on(sdk.RoomEvent.ParticipantDisconnected,roster);
  r.on(sdk.RoomEvent.TrackSubscribed,(t,pub,p)=>{if(!alive(g)||t.kind!==sdk.Track.Kind.Audio)return;roster();const peer=peers.get(p.identity);if(!peer)return;const audio=doc.createElement('audio');audio.playsInline=true;audio.hidden=true;doc.body.append(audio);audio.muted=muted.has(peer.playerId);peer.elements.add(audio);watchAudio(audio,peer,g,r);observeContext(g,r);audioTracks.set(audio,t);t.attach(audio);audio.muted=muted.has(peer.playerId);audio.play().then(()=>{if(alive(g)&&room===r&&peer.elements.has(audio)){listeningAuthorized=true;checkPlayback(g,r);}}).catch(()=>{if(alive(g)&&room===r&&peer.elements.has(audio)){playbackBlocked=true;emit();}});});
  r.on(sdk.RoomEvent.TrackUnsubscribed,t=>{t.detach();for(const [element,owner]of [...audioTracks])if(owner===t)for(const p of peers.values())if(p.elements.has(element))removeAudio(p,element);});
  r.on(sdk.RoomEvent.DataReceived,(bytes,p,kind,topic)=>{if(!alive(g)||topic!=='room-ptt-v1'||bytes.length!==1||bytes[0]>1)return;const peer=peers.get(p?.identity);if(!peer)return;peer.speaking=bytes[0]===1;win.clearTimeout(peer.timer);if(peer.speaking)peer.timer=win.setTimeout(()=>{peer.speaking=false;emit();},2200);emit();});
  r.on(sdk.RoomEvent.Disconnected,()=>{if(alive(g))leave('语音连接中断，请重新加入。');});
  r.on(sdk.RoomEvent.Reconnecting,()=>{if(alive(g))leave('语音连接中断，请重新加入。');});
  r.on(sdk.RoomEvent.AudioPlaybackStatusChanged,()=>checkPlayback(g,r,{recover:true}));
  r.startAudio().then(()=>{if(alive(g)&&room===r){listeningAuthorized=r.canPlaybackAudio;observeContext(g,r);checkPlayback(g,r);}}).catch(()=>{if(alive(g)&&room===r){playbackBlocked=true;emit();}});
  try{const result=await transport.join();if(!alive(g)){await r.disconnect(true);await transport.leave({id:result.id});return false;}
   terminal=result;await r.connect(result.url,result.token,{autoSubscribe:true});if(!alive(g)){await r.disconnect(true);return false;}
   joining=false;message='已加入，可按住发言或开启一直说。';roster();emit();return true;
  }catch(error){if(alive(g))leave('暂时连不上语音，请检查网络后重试。游戏可以继续。');return false;}
 }
 function microphone(g,r){
  if(micTask)return micTask.promise;
  if(track)return Promise.resolve(track);
  const flight={promise:null};micTask=flight;mic='requesting';emit();
  flight.promise=(async()=>{
   let acquired;
   try{
    acquired=await sdk.createLocalAudioTrack({echoCancellation:true,noiseSuppression:true,autoGainControl:true});
    acquired.mediaStreamTrack.enabled=false;
    if(!alive(g)||room!==r){acquired.stop();return null;}
    track=acquired;captureInterrupted=false;captureNeedsRepair=false;watchTrack(acquired,g,r);mic='granted';
    await r.localParticipant.publishTrack(acquired,{source:sdk.Track.Source.Microphone,audioPreset:sdk.AudioPresets.speech});
    acquired.mediaStreamTrack.enabled=false;
    if(!alive(g)||room!==r||track!==acquired){acquired.stop();return null;}
    emit();return acquired;
   }catch(error){
    if(track===acquired)clearTrack(acquired);acquired?.stop();
    if(alive(g)&&room===r){release();mic=error.name==='NotAllowedError'?'denied':'prompt';message=mic==='denied'?'麦克风未授权，仍可收听。':'麦克风暂不可用，仍可收听。';emit();}
    return null;
   }finally{if(micTask===flight)micTask=null;}
  })();
  return flight.promise;
 }
 async function start(modeWanted){
  if(!terminal||!room||joining||destroyed||doc.hidden)return false;
  if(systemInterrupted){message='系统仍在占用音频，请先结束听写。';emit();return false;}
  if(micTask?.repairRecord?.cancelled){message='上次麦克风请求尚未结束，请稍候再试。';emit();return false;}
  if(mode===modeWanted)return speaking;
  release();mode=modeWanted;const g=epoch,pressId=++gesture,r=room;message='';emit();
  if(modeWanted==='hold')timer=win.setTimeout(()=>{if(!alive(g)||gesture!==pressId||mode!=='hold')return;release();message='单次发言已满30秒，请松开后再说。';emit();},30000);
  const acquired=await microphone(g,r);
  if(!alive(g)||room!==r||mode!==modeWanted||pressId!==gesture||!acquired||track!==acquired)return false;
  if(acquired.mediaStreamTrack.readyState==='ended'){release();clearTrack(acquired);mic='prompt';message='麦克风已停止，点击发言可重试，仍可收听。';emit();return false;}
  if(acquired.mediaStreamTrack.muted===true||systemInterrupted){interruptCapture();return false;}
  return enableSpeech();
 }
 function press(){return mode==='open'?Promise.resolve(false):start('hold');}
 function setOpen(value){if(typeof value!=='boolean')throw new TypeError('Voice open state must be boolean.');if(!value){release();return Promise.resolve(false);}return start('open');}
 // Explicit repair is single-flight, starts in a user gesture and never rejoins.
 // A replacement is disabled before publication and cannot outlive its intent.
 function repairMicrophone(record){
  if(micTask)return Promise.resolve(null);
  const {g,r,pressId}=record,old=track,flight={promise:null,repairRecord:record};record.retiringTrack=old;micTask=flight;mic='requesting';captureNeedsRepair=true;emit();
  const valid=()=>alive(g)&&room===r&&repairTask===record&&!record.cancelled&&gesture===pressId&&mode==='open'&&!doc.hidden&&!systemInterrupted;
  flight.promise=(async()=>{let acquired,publishing=false;
   try{
    acquired=await sdk.createLocalAudioTrack({echoCancellation:true,noiseSuppression:true,autoGainControl:true});acquired.mediaStreamTrack.enabled=false;record.acquired=acquired;
    if(!valid()){acquired.stop();return null;}
    if(old){old.mediaStreamTrack.enabled=false;await old.mute();if(!valid()){acquired.stop();return null;}
     await r.localParticipant.unpublishTrack(old);old.stop();clearTrack(old);if(!valid()){acquired.stop();return null;}}
    track=acquired;watchTrack(acquired,g,r);
    publishing=true;record.publicationStarted=true;await r.localParticipant.publishTrack(acquired,{source:sdk.Track.Source.Microphone,audioPreset:sdk.AudioPresets.speech});acquired.mediaStreamTrack.enabled=false;
    if(!valid()||track!==acquired||acquired.mediaStreamTrack.readyState!=='live'||acquired.mediaStreamTrack.muted===true){
     if(track===acquired)clearTrack(acquired);acquired.stop();await r.localParticipant.unpublishTrack(acquired);return null;
    }
    mic='granted';captureInterrupted=false;captureNeedsRepair=false;return acquired;
   }catch(error){
    if(track===acquired)clearTrack(acquired);acquired?.stop();
    if(publishing)try{await r.localParticipant.unpublishTrack(acquired);}catch{}
    if(alive(g)&&room===r&&repairTask===record&&!record.cancelled){silence();captureInterrupted=true;mic=error.name==='NotAllowedError'?'denied':'prompt';message='麦克风尚未恢复，结束听写后再点恢复语音。';emit();}return null;
   }finally{if(micTask===flight)micTask=null;}
  })();return flight.promise;
 }
 function finishRepair(record,ok,{cancelled=false}={}){
  if(record.settled)return;record.settled=true;record.cancelled||=cancelled;win.clearTimeout(record.timer);
  if(cancelled){
   const acquired=record.acquired;
   if(acquired){acquired.mediaStreamTrack.enabled=false;if(track===acquired)clearTrack(acquired);acquired.stop();
    if(record.publicationStarted)try{Promise.resolve(record.r.localParticipant.unpublishTrack(acquired)).catch(()=>{});}catch{}
   }
   if(playbackTask?.promise===record.playback)finishPlayback(playbackTask,false);
   if(alive(record.g)&&room===record.r){mic='prompt';if(mode==='open'){silence();captureInterrupted=true;captureNeedsRepair=true;}message='恢复已取消，请稍后点恢复语音重试。';}
  }
  if(repairTask===record)repairTask=null;record.resolve(Boolean(ok));if(alive(record.g)&&room===record.r)emit();
 }
 function resumeAudio(){
  if(repairTask)return repairTask.promise;
  const g=epoch,r=room;if(!r||!terminal||joining||destroyed||doc.hidden)return Promise.resolve(false);
  if(systemInterrupted){message='系统仍在占用音频，请先结束听写，再点恢复语音。';emit();return Promise.resolve(false);}
  let resolve;const record={g,r,pressId:gesture,cancelled:false,settled:false,acquired:null,publicationStarted:false,playback:null,timer:null,promise:new Promise(done=>{resolve=done;}),resolve:null};record.resolve=resolve;repairTask=record;
  // Permission, SDK mute/unpublish/publish may never settle. Stop waiting after
  // eight seconds, retain their single flight, and retire every late result.
  record.timer=win.setTimeout(()=>finishRepair(record,false,{cancelled:true}),8000);emit();
  void(async()=>{
   const playback=recoverPlayback({explicit:true,verifyClock:true,rebind:true});record.playback=playback;
   const needsInput=mode==='open'&&openEstablished;
   // Begin capture while still in the explicit click stack, never from a timer.
   if(needsInput)silence();const microphone=needsInput?repairMicrophone(record):Promise.resolve(null);
   const [output,acquired]=await Promise.all([playback,microphone]);
   if(!alive(g)||room!==r||repairTask!==record||record.cancelled)return;
   const input=!needsInput||(!!acquired&&gesture===record.pressId&&mode==='open'&&enableSpeech());
   message=output&&input?'语音已恢复。':'语音尚未恢复，请结束听写后重试。';
   finishRepair(record,output&&input);
  })().catch(()=>{if(repairTask===record)finishRepair(record,false,{cancelled:true});});
  return record.promise;
 }
 const listen=(target,event,fn)=>{target.addEventListener(event,fn);bindings.push(()=>target.removeEventListener(event,fn));};
 // Pointer ownership belongs to the mounted controls. Unrelated canvas taps
 // must not release another finger's hold or an explicitly open microphone.
 // Backgrounding preserves an already live open microphone and listening room.
 // A held gesture or pending permission is not an established open microphone.
 function background(){foregroundRecoveryDone=false;playbackRecoveryTried=false;if(repairTask)finishRepair(repairTask,false,{cancelled:true});if(mode==='hold'||(mode==='open'&&!openEstablished))release();}
 const returned=()=>{if(!doc.hidden)void recoverPlayback({foreground:true});};
 listen(win,'blur',background);listen(win,'pagehide',()=>leave());listen(win,'focus',returned);listen(win,'pageshow',returned);listen(doc,'visibilitychange',()=>{if(doc.hidden)background();else returned();});
 const audioSession=win.navigator.audioSession;
 if(audioSession?.addEventListener){
  const changed=()=>{const wasInterrupted=systemInterrupted;systemInterrupted=audioSession.state==='interrupted';if(systemInterrupted){if(room){playbackBlocked=true;interruptCapture();}}else if(wasInterrupted){message='已结束音频中断，可继续收听。';resumeExistingCapture();if(room)void recoverPlayback({foreground:true,verifyClock:true});}emit();};
  systemInterrupted=audioSession.state==='interrupted';listen(audioSession,'statechange',changed);
 }
 const unsubscribe=transport.subscribe?.(packet=>{if(packet.kind==='closed'&&packet.target===terminal?.id)leave('原语音连接已结束。');});
 function mute(playerId,value){value?muted.add(playerId):muted.delete(playerId);for(const p of peers.values())if(p.playerId===playerId)for(const a of p.elements)a.muted=value;emit();if(!value&&room&&outputBlocked(room))void recoverPlayback({explicit:true});}
 return {state,join,press,release,releaseHold,setOpen,leave,mute,
  resumePlayback:()=>recoverPlayback({explicit:true}),resumeAudio,destroy(){if(destroyed)return;leave('');destroyed=true;unsubscribe?.();bindings.forEach(f=>f());},get room(){return room;}};
}
