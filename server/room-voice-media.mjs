import {signVoiceToken} from './room-voice-service.mjs';
/** Fixed loopback administration only; never accept the origin from a browser.
 * Uncertain revocation is fatal to the owned audio process, not to the game. */
export function createRoomVoiceMedia({origin,apiKey,secret,stop,fetch:request=globalThis.fetch,timeoutMs=2000}={}){
 const url=new URL(origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash||typeof stop!=='function'||timeoutMs!==2000)throw new TypeError('Voice admin requires a fixed private loopback and owned stop.');
 let closed=false,closeFlight=null;const controllers=new Set();
 return {get ready(){return !closed;},
  async remove({room,identity}){
   if(closed)throw new Error('语音已关闭。');if(!/^voice-[a-f0-9]{32}$/.test(room)||!/^[A-Za-z0-9_-]{16,128}$/.test(identity))throw new TypeError('Invalid owned media target.');
   const controller=new AbortController();controllers.add(controller);let timer;try{
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Voice admin deadline'));},timeoutMs);});
    const result=(async()=>{
    const jwt=signVoiceToken({apiKey,secret,subject:'room-voice-admin',grant:{room,roomAdmin:true}});
    const response=await request(new URL('/twirp/livekit.RoomService/RemoveParticipant',url),{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt},body:JSON.stringify({room,identity})});
    const reader=response.body?.getReader();let data='',bytes=0;const decoder=new TextDecoder();if(reader)try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>8192)throw new Error('Large voice reply');data+=decoder.decode(next.value,{stream:true});}}finally{reader.releaseLock();}
    if(response.ok)return;let body;try{body=JSON.parse(data);}catch{}if(response.status===404&&body?.code==='not_found')return;throw new Error('Media revocation failed');
    })();await Promise.race([result,deadline]);
   }catch{throw new Error('语音退出结果无法确认。');}finally{clearTimeout(timer);controllers.delete(controller);}
  },
  close(){if(closeFlight)return closeFlight;closed=true;for(const c of controllers)c.abort();controllers.clear();closeFlight=Promise.resolve().then(stop);return closeFlight;},
 };
}
