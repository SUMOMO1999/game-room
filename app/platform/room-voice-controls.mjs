import {createRoomVoice} from './room-voice.mjs';

/** The own-seat control is mounted once. Score and roster refreshes must not
 * replace the button under a held finger. Remote badges belong to each game. */
export function mountRoomVoiceControls({root,transport,document:doc=globalThis.document,window:win=globalThis.window,onState=()=>{},createVoice=createRoomVoice,compact=null,...options}={}) {
  if(!root)throw new TypeError('Room voice needs a stable seat control.');
  if(compact&&(!compact.joinRoot||!compact.microphoneRoot||!compact.statusRoot))throw new TypeError('Compact voice needs stable join, microphone and status slots.');
  const make=(tag,className,text)=>{const n=doc.createElement(tag);n.className=className;if(text)n.textContent=text;return n;};
  const panel=make('section','room-voice'),row=make('div','room-voice-row'),title=make('strong','room-voice-title','房间语音'),actions=make('div','room-voice-actions'),join=make('button','room-voice-join','加入语音'),button=make('button','room-voice-talk','按住'),open=make('button','room-voice-open','一直说'),leave=make('button','room-voice-leave','×'),status=make('span','room-voice-status'),listen=make('button','room-voice-listen','恢复语音');
  for(const action of [join,button,open,leave,listen])action.type='button';
  join.setAttribute('aria-label','加入房间语音');button.setAttribute('aria-label','按住向房间发言，松开静音');button.setAttribute('aria-pressed','false');open.setAttribute('aria-label','开启一直说，再点停止');open.setAttribute('aria-pressed','false');leave.setAttribute('aria-label','退出房间语音');status.setAttribute('role','status');
  if(compact){
    panel.classList.add('room-voice-compact');join.classList.add('room-voice-compact-join','room-toolbar-action');open.classList.add('room-voice-compact-microphone','room-toolbar-action');
    leave.textContent='退出语音';leave.setAttribute('aria-label','退出房间语音');open.textContent='';
    panel.append(title,leave);root.append(panel);compact.joinRoot.append(join);compact.microphoneRoot.append(open);compact.statusRoot.append(status);
  }else{row.append(title,join,leave);actions.append(button,open);panel.append(row,actions,listen,status);root.append(panel);}
  let destroyed=false,available=true,pressedPointer=null,pressedKey=null,voice;const names=new Map();const listeners=[];
  const bind=(target,type,fn,opts)=>{target.addEventListener(type,fn,opts);listeners.push(()=>target.removeEventListener(type,fn,opts));};
  function render(s){
    if(destroyed)return;
    panel.classList.toggle('speaking',s.speaking);panel.classList.toggle('joined',s.joined);panel.classList.toggle('mode-open',s.mode==='open');panel.classList.toggle('mode-hold',s.mode==='hold');panel.classList.toggle('unavailable',!available);panel.setAttribute('aria-disabled',String(!available));
    const recovering=s.audioRecovering===true||s.playbackRecovering===true,interrupted=s.playbackBlocked||s.captureInterrupted||s.systemInterrupted;
    join.textContent=compact?(s.joined?(recovering?'恢复中':interrupted?'恢复语音':'收听中'):'加入语音'):(s.joined?'恢复语音':'加入语音');join.setAttribute('aria-label',s.joined?'恢复房间语音':'加入房间语音');join.title=s.joined?'已加入，点按可恢复收听与麦克风':'加入房间语音，只收听';
    join.disabled=!available||!s.supported||s.joining||(s.joined&&(recovering||s.mic==='requesting'));join.setAttribute('aria-busy',String(s.joining||recovering));
    button.disabled=!available||!s.supported||!s.joined||s.joining||s.mode==='open';button.setAttribute('aria-pressed',String(s.mode==='hold'));
    open.disabled=!available||!s.supported||!s.joined||s.joining;open.setAttribute('aria-pressed',String(s.mode==='open'));open.setAttribute('aria-label',s.mode==='open'?'停止一直说':'开启一直说，再点停止');
    if(compact){open.setAttribute('aria-label',s.mode==='open'?'关闭麦克风，停止发言':'开启麦克风，持续发言');open.title=s.mode==='open'?'关闭麦克风':'开启麦克风';open.classList.toggle('speaking',s.speaking);}
    leave.disabled=!s.joined&&!s.joining;listen.hidden=!(s.playbackBlocked||s.captureInterrupted||s.systemInterrupted||s.audioRecovering);listen.disabled=!available||s.playbackRecovering===true||s.audioRecovering===true;listen.setAttribute('aria-busy',String(s.playbackRecovering===true||s.audioRecovering===true));
    const speaking=s.peers.filter(p=>p.speaking&&!p.muted),people=speaking.slice(0,2).map(p=>names.get(p.playerId)??'朋友').join('、');
    const text=!available?'语音已断开，恢复房间后可重新加入。':!s.supported?'此浏览器暂不支持语音。':s.joining?'正在加入语音…':s.audioRecovering?'正在恢复语音…':s.systemInterrupted?'系统正在占用音频，请先结束听写。':s.captureInterrupted?'麦克风已中断，结束听写后点恢复语音。':s.mode!=='off'&&s.mic==='requesting'?'请允许麦克风，可随时停止。':s.mode==='open'?'麦克风已开启，再点“一直说”停止。':s.speaking?'正在发言，松开停止。':speaking.length?`${people}${speaking.length>2?'等'+speaking.length+'人':''}正在说话`:s.message||(s.joined?'按住发言，或点一直说。':'纯语音聊天，不录音。');
    const message=compact?text.replace('再点“一直说”停止','再点麦克风停止').replace('按住发言，或点一直说','点底部麦克风发言'):text;
    if(status.textContent!==message)status.textContent=message;
    onState(s);
  }
  voice=createVoice({...options,transport,document:doc,window:win,onChange:render});
  const release=()=>{pressedPointer=null;pressedKey=null;voice.releaseHold();};
  const releasePointer=event=>{if(pressedPointer===null||event.pointerId!==pressedPointer)return;release();};
  bind(join,'click',()=>{if(join.disabled||!available)return;if(voice.state().joined)voice.resumeAudio();else if(!voice.state().joining)voice.join();});
  if(!compact){
  bind(button,'pointerdown',event=>{
    if(event.button!==0||pressedPointer!==null||pressedKey!==null||button.disabled||!available||!voice.state().joined||voice.state().mode==='open')return;
    event.preventDefault();pressedPointer=event.pointerId;button.setPointerCapture?.(event.pointerId);voice.press();
  });
  bind(button,'pointermove',event=>{
    if(pressedPointer!==event.pointerId)return;const box=button.getBoundingClientRect();
    if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)release();
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])bind(button,type,releasePointer);
  for(const type of ['pointerup','pointercancel'])bind(win,type,releasePointer);
  bind(button,'keydown',event=>{if(![' ','Enter'].includes(event.key)||event.repeat||pressedKey!==null||pressedPointer!==null||button.disabled||!available||!voice.state().joined)return;event.preventDefault();pressedKey=event.key;voice.press();});
  bind(button,'keyup',event=>{if(event.key===pressedKey){event.preventDefault();release();}});
  bind(button,'blur',release);bind(button,'contextmenu',event=>event.preventDefault());
  bind(win,'blur',()=>{pressedPointer=null;pressedKey=null;});
  bind(doc,'visibilitychange',()=>{if(doc.hidden){pressedPointer=null;pressedKey=null;}});
  }
  bind(open,'click',()=>{if(open.disabled||!available)return;pressedPointer=null;pressedKey=null;voice.setOpen(voice.state().mode!=='open');});
  bind(leave,'click',()=>{release();voice.leave();});bind(listen,'click',()=>voice.resumeAudio());render(voice.state());
  return {voice,element:panel,
    setMembers(members){names.clear();for(const p of members??[])names.set(p.id,p.name);render(voice.state());},
    setAvailable(value){const next=Boolean(value),previous=available;available=next;if(previous&&!next){pressedPointer=null;pressedKey=null;voice.leave('语音已断开，恢复房间后可重新加入。');}render(voice.state());},
    destroy(){if(destroyed)return;destroyed=true;voice.destroy();listeners.forEach(remove=>remove());panel.remove();if(compact)for(const node of [join,open,status])node.remove();},
  };
}
