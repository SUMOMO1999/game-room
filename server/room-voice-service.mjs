import {supportsRoomVoice,roomVoicePages} from '../app/platform/room-voice-policy.mjs';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {RoomError} from '../app/rooms.mjs';
const fail=(status,code,text)=>{throw new RoomError(status,code,text);};
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(value);
const exact=(v,fields)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(f=>Object.hasOwn(v,f));
const same=(a,b)=>['roomId','playerId','sessionId'].every(k=>a[k]===b[k]);
export function signVoiceToken({apiKey,secret,subject,grant,metadata,now=Date.now(),ttlSeconds=30}){
 if(typeof apiKey!=='string'||!apiKey||typeof secret!=='string'||secret.length<32||!Number.isInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>60)throw new TypeError('Voice signing requires a dedicated short-lived key.');
 const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),time=Math.floor(now/1000),head=encode({alg:'HS256',typ:'JWT'}),body=encode({iss:apiKey,sub:subject,iat:time,nbf:time-1,exp:time+ttlSeconds,video:grant,...(metadata?{metadata:JSON.stringify(metadata)}:{})});
 const text=head+'.'+body;return text+'.'+createHmac('sha256',secret).update(text).digest('base64url');
}
/** The BFF owns ephemeral media capabilities. Game state, SDP, PCM and recordings
 * never enter this service or SQLite. Failed revocation stops the owned SFU. */
export function createRoomVoiceService({media,apiKey,secret,now=Date.now,id=randomUUID,leaseMs=30000,
 timers={setInterval,clearInterval}}={}){
 if(!media||!['remove','close'].every(k=>typeof media[k]==='function')||leaseMs!==30000)throw new TypeError('Voice requires an owned, fail-closed media process.');
 const terminals=new Map(),subscribers=new Set(),revocations=new Set(),tasks=new Set();let closed=false,available=true,stopError=null,closeFlight=null;
 function owned(task){tasks.add(task);task.finally(()=>tasks.delete(task)).catch(()=>{});return task;}
 const roomName=roomId=>'voice-'+roomId;
 function authority(a){if(closed||!available||media.ready===false)fail(424,'VOICE_UNAVAILABLE','房间语音暂时不可用，文字聊天和游戏可继续。');
  if(!a||!supportsRoomVoice(a.gameType)||![a.roomId,a.playerId,a.sessionId].every(token))fail(403,'VOICE_MEMBER','请恢复房间席位后加入语音。');}
 const find=a=>[...terminals.values()].find(m=>m.roomId===a.roomId&&m.playerId===a.playerId);
 function notify(m){for(const revoke of revocations)try{revoke(m.id);}catch{}for(const s of subscribers)if(s.roomId===m.roomId&&s.sessionId===m.sessionId)try{s.receive({roomId:m.roomId,target:m.id,kind:'closed'});}catch{s.error?.();}}
 function stop(){if(!available)return;available=false;for(const m of terminals.values())notify(m);terminals.clear();owned(Promise.resolve().then(()=>media.close()).catch(()=>{stopError=Error('Owned audio process stop was not confirmed.');}));}
 function remove(m){if(terminals.get(m.id)===m)terminals.delete(m.id);notify(m);
  return owned(Promise.resolve().then(()=>media.remove({room:roomName(m.roomId),identity:m.id})).catch(()=>{stop();}));}
 function current(a,body){authority(a);if(!exact(body,['id','clientId'])||!token(body.id)||!token(body.clientId))fail(400,'VOICE_INPUT','语音终端信息无效。');
  const m=terminals.get(body.id);if(!m||!same(a,m)||m.clientId!==body.clientId||m.validUntil<=now())fail(409,'VOICE_STALE','原语音连接已结束，请重新加入。');return m;}
 const sweep=timers.setInterval(()=>{if(media.ready===false){stop();return;}for(const m of terminals.values())if(m.validUntil<=now())remove(m);},1000);sweep.unref?.();
 return {kind:'sfu-v1',get ready(){return !closed&&available&&media.ready!==false;},
  // Self-hosted SFU tokens can be refreshed for reconnects. Every public media
  // handshake must also prove this still-live room capability and cookie.
  authorizeMedia(jwt){
   if(typeof jwt!=='string'||jwt.length>8192)fail(403,'VOICE_TOKEN','语音授权无效。');
   let claims;try{const parts=jwt.split('.');if(parts.length!==3)throw Error();const header=JSON.parse(Buffer.from(parts[0],'base64url')),signature=Buffer.from(parts[2],'base64url'),expected=createHmac('sha256',secret).update(parts[0]+'.'+parts[1]).digest();
    if(header.alg!=='HS256'||signature.length!==expected.length||!timingSafeEqual(signature,expected))throw Error();claims=JSON.parse(Buffer.from(parts[1],'base64url'));if(claims.iss!==apiKey||!Number.isFinite(claims.exp)||claims.exp*1000<=now()||claims.nbf*1000>now())throw Error();
   }catch{fail(403,'VOICE_TOKEN','语音授权无效。');}
   const m=terminals.get(claims.sub);if(!m||m.validUntil<=now()||claims.video?.room!==roomName(m.roomId)||claims.video.roomJoin!==true)fail(403,'VOICE_TOKEN','原语音授权已结束。');authority(m);return {...m};
  },
  assertMedia(permit,a){authority(a);const m=terminals.get(permit.id);if(!m||!same(m,a)||m.validUntil<=now()||m.clientId!==permit.clientId)fail(403,'VOICE_TOKEN','原语音授权已结束。');return m.id;},
  subscribeRevocation(fn){revocations.add(fn);return()=>revocations.delete(fn);},
  async prepare(a,action,body){authority(a);
   if(action==='leave')return {action,a:{...a},m:current(a,body)};
   if(action!=='join')fail(404,'VOICE_ENDPOINT','语音接口不存在。');
   if(!exact(body,['clientId'])||!token(body.clientId))fail(400,'VOICE_INPUT','语音终端信息无效。');
   if(![...subscribers].some(s=>s.roomId===a.roomId&&s.sessionId===a.sessionId))fail(409,'VOICE_STREAM_REQUIRED','先恢复房间连接，再加入语音。');
   const previous=find(a),reuse=previous&&same(a,previous)&&previous.clientId===body.clientId&&previous.validUntil>now();
   const m=reuse?previous:{...a,id:id(),clientId:body.clientId,validUntil:now()+leaseMs};
   authority(a);const issuedAt=now();
   const signed=signVoiceToken({apiKey,secret,subject:m.id,grant:{room:roomName(a.roomId),roomJoin:true,canSubscribe:true,canPublish:true,canPublishData:true,canPublishSources:['microphone'],canUpdateOwnMetadata:false},metadata:{playerId:a.playerId},now:issuedAt});
   return {action,a:{...a},m,previous:previous??null,issuedAt,signed};
  },
  commit(prepared,a){authority(a);if(!same(prepared.a,a))fail(409,'VOICE_AUTHORITY_CHANGED','房间席位或登录已变化。');
   if(prepared.action==='leave'){const m=terminals.get(prepared.m.id);if(m===prepared.m&&same(a,m))remove(m);return {ok:true};}
   if(now()-prepared.issuedAt>=10000)fail(409,'VOICE_TOKEN_OLD','语音授权已过期，请重新加入。');
   const current=find(a)??null;if(current!==prepared.previous||prepared.previous&&prepared.previous.validUntil<=now())fail(409,'VOICE_TERMINAL_CHANGED','另一设备已加入语音，请重新确认。');
   if(current&&current!==prepared.m)remove(current);
   if(!current&&[...terminals.values()].filter(m=>m.roomId===a.roomId).length>=16)fail(409,'VOICE_FULL','房间语音已满。');
   if(!current&&terminals.size>=1600)fail(424,'VOICE_CAPACITY','房间语音暂时繁忙。');
   if(![...subscribers].some(s=>s.roomId===a.roomId&&s.sessionId===a.sessionId))fail(409,'VOICE_STREAM_REQUIRED','房间连接已结束。');
   const m=prepared.m;m.validUntil=now()+leaseMs;terminals.set(m.id,m);return {id:m.id,token:prepared.signed,kind:'sfu-v1'};
  },
  active(roomId,sessionId){return [...terminals.values()].some(m=>m.roomId===roomId&&m.sessionId===sessionId&&m.validUntil>now());},
  renew(a){if(closed||!available)return false;if(media.ready===false){stop();return false;}authority(a);for(const m of terminals.values())if(same(a,m)&&m.validUntil>now())m.validUntil=now()+leaseMs;},
  invalidateSession(sessionId){for(const m of [...terminals.values()])if(m.sessionId===sessionId)remove(m);},
  subscribe(a,receive,error){if(closed||!available||media.ready===false)return ()=>{};authority(a);if(subscribers.size>=1600)fail(424,'VOICE_CAPACITY','语音连接暂时繁忙。');const s={roomId:a.roomId,sessionId:a.sessionId,receive,error};subscribers.add(s);
   return ()=>{subscribers.delete(s);if(![...subscribers].some(x=>x.roomId===a.roomId&&x.sessionId===a.sessionId))for(const m of [...terminals.values()])if(m.roomId===a.roomId&&m.sessionId===a.sessionId)remove(m);};},
  packet(a,value){authority(a);return value?.kind==='closed'&&value.roomId===a.roomId?{roomId:a.roomId,target:value.target,kind:'closed'}:null;},
  async settle(){while(tasks.size)await Promise.allSettled([...tasks]);},
  close(){if(closeFlight)return closeFlight;stop();closed=true;timers.clearInterval(sweep);subscribers.clear();revocations.clear();closeFlight=(async()=>{while(tasks.size)await Promise.allSettled([...tasks]);if(stopError)throw stopError;})();return closeFlight;},
 };
}
