import {supportsRoomVoice,roomVoicePages} from '../app/platform/room-voice-policy.mjs';
import {RoomError} from '../app/rooms.mjs';
import {IdentityFailure} from './auth.mjs';
import {prepareCurrentRoomOutput} from './room-output-fence.mjs';
import {createIdentityCheckContext} from './identity-check-context.mjs';
import {requestContext,entryPath} from './entry-context.mjs';
export const voiceAuthority=(session,room,code)=>({sessionId:session.id,roomId:room.roomId,playerId:room.seatId??room.selfId,gameType:room.gameType,code});
export function createRoomVoiceHttp({sessions,rooms,voice,limit,readJson,reply}={}){
 return async function route({req,res,url,webRequest,context}){
  if(!/^\/api\/rooms\/[^/]+\/voice(?:\/|$)/.test(url.pathname))return false;
  const match=/^\/api\/rooms\/(\d{6})\/voice\/(join|leave)$/.exec(url.pathname);
  if(!match){reply(res,404,{error:'语音接口不存在。'});return true;}
  if(req.method!=='POST'){reply(res,405,{error:'请使用 POST。'},{Allow:'POST'});return true;}
  if(url.search)throw new RoomError(400,'VOICE_QUERY','语音接口不接受额外参数。');
  const owned=context?null:new AbortController(),cancel=()=>owned?.abort();if(owned){req.once('aborted',cancel);res.once('close',cancel);context=createIdentityCheckContext({now:sessions.now,signal:owned.signal,timeoutMs:Math.min(8000,sessions.authorizationTimeoutMs??8000)});}
  try{
  const [,code,action]=match,wait=operation=>context?context.wait(operation):operation();
  const session=await sessions.authorize(webRequest,context?{fresh:true,touch:false,context}:{fresh:true,touch:false});sessions.checkWrite(webRequest,session);limit(`voice-user:${session.userKey}`,20);
  const body=await wait(()=>readJson(req,1024)),initial=await wait(()=>rooms.getGameContext(code,session.userKey,{includeView:false}));
  if(!supportsRoomVoice(initial.gameType))throw new RoomError(403,'VOICE_UNSUPPORTED','本游戏暂未开放语音。');
  const prepared=await wait(()=>voice.prepare(voiceAuthority(session,initial,code),action,body));
  const after=await sessions.authorize(webRequest,context?{fresh:true,touch:false,context}:{fresh:true,touch:false});
  if(!after||['id','userKey','issuer','sub'].some(f=>after[f]!==session[f]))throw new IdentityFailure();
  if(context&&after.authorizationLineage!==session.authorizationLineage)throw new IdentityFailure(503);
  const prepare=async()=>{const room=await wait(()=>rooms.getGameContext(code,session.userKey,{includeView:false}));if(room.roomId!==initial.roomId||room.seatId!==initial.seatId||room.gameType!==initial.gameType)throw new RoomError(409,'VOICE_ROOM_CHANGED','原房间席位已变化。');return {room,guards:[room.roomGuard,room.presenceGuard,...(room.invitationGuard?[room.invitationGuard]:[])]};};
  const output=context?await prepareCurrentRoomOutput({sessions,session:after,context,prepare}):await prepare();context?.assert();
  if(req.aborted||res.destroyed||res.writableEnded)return true;
  const result=voice.commit(prepared,voiceAuthority(after,output.room,code));
  if(action==='join'){const entry=requestContext(webRequest).entry;result.url=entry.origin.replace(/^http/,'ws')+entryPath(entry,'/voice');}
  reply(res,200,result);return true;
  }finally{if(owned){req.off('aborted',cancel);res.off('close',cancel);context.dispose();}}
 };
}
