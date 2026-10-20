import {accountState} from '../account-client.mjs';
import {supportsRoomVoice} from './room-voice-policy.mjs';
import {mountRoomVoiceControls} from './room-voice-controls.mjs';
import {mountRoomVoiceHost} from './room-voice-host.mjs';

/** Decorate the existing transport, rather than starting a second room/session.
 * All media requests inherit its identity epoch, CSRF and abort ownership. The
 * game still owns rendering, actions, reconnects, exit and membership. */
export function withRoomVoice(BaseRoomClient,{gameType,getAccount=accountState,
  createControls=mountRoomVoiceControls,mountHost=mountRoomVoiceHost,
  document:doc=globalThis.document,window:win=globalThis.window}={}) {
  if(!supportsRoomVoice(gameType))throw new TypeError('此游戏不提供房间语音。');
  return class VoiceRoomClient extends BaseRoomClient {
    constructor(code,membership,callbacks) {
      let owner;
      super(code,membership,{...callbacks,
        onView:view=>{callbacks.onView(view);try{owner?.voiceView(view);}catch{owner?.voiceSetupFailure();}},
        onConnection:value=>{callbacks.onConnection(value);owner?.voiceConnection(value);},
        onVoice:packet=>{callbacks.onVoice?.(packet);owner?.voiceReceive?.(packet);},
      });
      owner=this;this.voiceOnline=false;this.voiceControls=null;this.voiceHost=null;this.voiceReceive=null;
      this.voiceClientId=null;this.voiceMembers=new Map();this.voicePeerButtons=new Map();
    }
    voiceView(view) {
      if(this.stopped||this.voiceFailed)return;
      const account=getAccount(),allowed=account.authenticated&&account.voiceEnabled&&account.voiceKind==='sfu-v1'&&view.gameType===gameType;
      if(!allowed){this.closeVoice();return;}
      if(!this.live(this.epoch()))return;
      if(!this.voiceControls) {
        this.voiceClientId=win.crypto.randomUUID();this.voiceHost=mountHost({document:doc,gameType});
        const transport={
          subscribe:receive=>{this.voiceReceive=receive;return()=>{if(this.voiceReceive===receive)this.voiceReceive=null;};},
          join:()=>this.voiceRequest('join',{clientId:this.voiceClientId}),
          leave:body=>this.voiceRequest('leave',{...body,clientId:this.voiceClientId}),
        };
        const host=this.voiceHost;
        this.voiceControls=createControls({root:host.root,transport,document:doc,window:win,
          compact:{joinRoot:host.joinRoot,microphoneRoot:host.microphoneRoot,statusRoot:host.statusRoot},
          onState:state=>this.voiceRoster(state)});
        for(const slot of [host.joinRoot,host.microphoneRoot])slot.firstElementChild?.classList.add('room-toolbar-action');
      }
      this.voiceMembers=new Map([...(view.players??[]),...(view.spectators??[])].map(p=>[p.id,p]));
      this.voiceControls.setMembers([...this.voiceMembers.values()]);
      this.voiceControls.setAvailable(this.voiceOnline);
    }
    voiceConnection(value) {
      this.voiceOnline=value==='online';this.voiceControls?.setAvailable(this.voiceOnline&&!this.stopped);
    }
    voiceRequest(action,body) {
      const epoch=this.epoch(),account=getAccount();
      if(!this.live(epoch)||!account.authenticated||account.verification!=='verified'||!account.voiceEnabled||account.voiceKind!=='sfu-v1')return Promise.reject(new Error('请恢复房间和登录后加入语音。'));
      return this.request(`/api/rooms/${this.code}/voice/${action}`,{method:'POST',body,token:this.membership.token},epoch);
    }
    voiceRoster(state) {
      if(!this.voiceHost)return;
      const active=new Set();
      for(const peer of state.peers??[]) {
        if(peer.playerId===this.membership.playerId)continue;
        active.add(peer.playerId);let button=this.voicePeerButtons.get(peer.playerId);
        if(!button){button=doc.createElement('button');button.type='button';button.className='room-voice-peer';button.addEventListener('click',()=>{const current=this.voiceControls?.voice.state().peers.find(p=>p.playerId===peer.playerId);if(current)this.voiceControls.voice.mute(peer.playerId,!current.muted);});this.voiceHost.peers.append(button);this.voicePeerButtons.set(peer.playerId,button);}
        const name=this.voiceMembers.get(peer.playerId)?.name??'房间成员';
        button.textContent=`${name} · ${peer.muted?'已静音':peer.speaking?'正在发言':'收听中'}`;
        button.setAttribute('aria-label',`${peer.muted?'取消静音':'仅对我静音'} ${name}`);button.setAttribute('aria-pressed',String(peer.muted));
      }
      for(const [id,button] of this.voicePeerButtons)if(!active.has(id)){button.remove();this.voicePeerButtons.delete(id);}
    }
    voiceSetupFailure(){
      this.closeVoice();this.voiceFailed=true;
      const settings=doc.querySelector('.game-settings-body');
      if(settings){const note=doc.createElement('p');note.setAttribute('role','status');note.textContent='房间语音暂时不可用，游戏可以继续。重新进入房间可恢复语音入口。';settings.append(note);this.voiceFailureNode=note;}
    }
    closeVoice(){this.voiceControls?.destroy();this.voiceControls=null;this.voiceHost?.destroy();this.voiceHost=null;this.voiceReceive=null;this.voicePeerButtons.clear();}
    stop(){this.closeVoice();this.voiceFailureNode?.remove();super.stop();}
  };
}
