import http from 'node:http';
import {bridgeVoiceSockets} from './room-voice-pipe.mjs';
import {RoomError} from '../app/rooms.mjs';
import {IdentityFailure} from './auth.mjs';
import {resolveEntry,bindEntry} from './entry-context.mjs';
import {createIdentityCheckContext,bindIdentityCheckContext,unbindIdentityCheckContext} from './identity-check-context.mjs';
import {prepareCurrentRoomOutput} from './room-output-fence.mjs';
import {voiceAuthority} from './room-voice-http.mjs';

/** Only RTC handshake paths reach a fixed loopback SFU. Its Twirp admin API is
 * never public. A signed token alone is insufficient: the current room cookie,
 * fresh provider and live ephemeral terminal must all agree, on every reconnect. */
export function createRoomVoiceProxy({sessions,rooms,voice,entries,origin,limit}={}) {
 const target=new URL(origin);
 if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.pathname!=='/'||target.username||target.password||target.search||target.hash)throw TypeError('Expected fixed voice loopback.');
 const sockets=new Map();let closed=false;
 const unsubscribe=voice.subscribeRevocation(id=>{for(const [socket,owner]of sockets)if(owner===id)socket.destroy();});
 const fail=(status,code)=>{throw new RoomError(status,code,'语音连接未通过房间验证。');};
 async function authorize(req,signal){
  if(closed)fail(424,'VOICE_UNAVAILABLE');
  let entry,externalUrl,logicalPath;try{({entry,externalUrl,logicalPath}=resolveEntry(req,typeof entries==='function'?entries():entries));}catch{fail(403,'VOICE_ENTRY');}
  if(!/^\/voice\/rtc(?:\/v1)?(?:\/validate)?$/.test(logicalPath))fail(404,'VOICE_PATH');
  if(req.method!=='GET')fail(405,'VOICE_METHOD');
  if(req.headers.origin&&req.headers.origin!==entry.origin||req.headers['sec-fetch-site']==='cross-site')fail(403,'VOICE_ORIGIN');
  if(req.headers.authorization)fail(403,'VOICE_AUTH_HEADER');
  const jwt=externalUrl.searchParams.getAll('access_token');if(jwt.length!==1)fail(403,'VOICE_TOKEN');
  const permit=voice.authorizeMedia(jwt[0]);
  limit('voice-media-global',120);limit('voice-media-session:'+permit.sessionId,20);
  const request=new Request(externalUrl,{method:'GET',headers:req.headers});bindEntry(request,entry,logicalPath);
  const context=createIdentityCheckContext({now:sessions.now,signal,timeoutMs:Math.min(8000,sessions.authorizationTimeoutMs??8000)});
  if(sessions.usesBatchIdentity)bindIdentityCheckContext(request,context);
  try{
   const session=await sessions.authorize(request,{fresh:true,touch:false,...(sessions.usesBatchIdentity?{context}:{})});
   if(session.id!==permit.sessionId)fail(403,'VOICE_COOKIE');
   const prepare=async()=>{const room=await context.wait(()=>rooms.getGameContext(permit.code,session.userKey,{includeView:false}));return {room,guards:[room.roomGuard,room.presenceGuard,...(room.invitationGuard?[room.invitationGuard]:[])]};};
   const output=await prepareCurrentRoomOutput({sessions,session,context,prepare});context.assert();
   const id=voice.assertMedia(permit,voiceAuthority(session,output.room,permit.code));
   return {id,path:logicalPath.slice('/voice'.length)+externalUrl.search};
  }finally{if(sessions.usesBatchIdentity)unbindIdentityCheckContext(request,context);context.dispose();}
 }
 function upstream(req,path){const headers={Host:target.host};for(const name of ['upgrade','connection','sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions'])if(req.headers[name])headers[name]=req.headers[name];return http.request(new URL(path,target),{method:'GET',headers});}
 const denied=(error,res)=>{const status=error instanceof RoomError||error instanceof IdentityFailure?error.status:424;res.writeHead(status,{'Cache-Control':'no-store','Content-Type':'text/plain; charset=utf-8'});res.end('房间语音暂时无法连接。');};
 return {
  async http(req,res){const cancel=new AbortController();const end=()=>cancel.abort();req.once('aborted',end);res.once('close',end);try{
    const permit=await authorize(req,cancel.signal);if(cancel.signal.aborted)return;
    if(!req.url.split('?')[0].endsWith('/validate'))fail(426,'VOICE_UPGRADE_REQUIRED');
    const out=upstream(req,permit.path);const timer=setTimeout(()=>out.destroy(),3000);out.on('response',up=>{res.writeHead(up.statusCode,{'Cache-Control':'no-store','Content-Type':'text/plain; charset=utf-8'});let size=0;up.on('data',chunk=>{size+=chunk.length;if(size>8192){out.destroy();res.destroy();}else res.write(chunk);});up.on('end',()=>res.end());up.on('error',()=>res.destroy());});out.on('error',()=>{if(!res.headersSent)denied(Error(),res);else res.destroy();});out.on('close',()=>clearTimeout(timer));res.once('close',()=>out.destroy());out.end();
   }catch(error){if(!res.destroyed&&!res.writableEnded)denied(error,res);}finally{req.off('aborted',end);res.off('close',end);}},
  async upgrade(req,socket,head){const cancel=new AbortController();let out,timer,switched=false;const abort=()=>{cancel.abort();if(!switched)out?.destroy();clearTimeout(timer);if(!switched)sockets.delete(socket);};socket.once('close',abort);socket.pause();
   try{if(!Buffer.isBuffer(head)||head.length>65536)fail(400,'VOICE_HEAD');const permit=await authorize(req,cancel.signal);if(cancel.signal.aborted||socket.destroyed)return;if(req.url.split('?')[0].endsWith('/validate'))fail(400,'VOICE_UPGRADE');if(sockets.size>=256)fail(424,'VOICE_CAPACITY');
    sockets.set(socket,permit.id);out=upstream(req,permit.path);timer=setTimeout(()=>{out.destroy();socket.destroy();},3000);
    out.once('upgrade',(response,remote,remoteHead)=>{clearTimeout(timer);if(socket.destroyed||closed){remote.destroy();return;}let headers=`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`;for(let i=0;i<response.rawHeaders.length;i+=2)headers+=response.rawHeaders[i]+': '+response.rawHeaders[i+1]+'\r\n';socket.write(headers+'\r\n');switched=true;bridgeVoiceSockets(socket,remote,{head,remoteHead,onClose:()=>sockets.delete(socket)});});
    out.once('response',()=>{clearTimeout(timer);socket.end('HTTP/1.1 424 Failed Dependency\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');out.destroy();});out.once('error',()=>socket.destroy());out.end();
   }catch(error){if(!socket.destroyed){const status=error instanceof RoomError||error instanceof IdentityFailure?error.status:424;socket.end(`HTTP/1.1 ${status} Voice Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}}
  },
  close(){if(closed)return;closed=true;unsubscribe();for(const socket of sockets.keys())socket.destroy();sockets.clear();},
 };
}
