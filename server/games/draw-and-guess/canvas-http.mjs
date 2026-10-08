import { RoomError } from '../../../app/rooms.mjs';
import { IdentityFailure } from '../../auth.mjs';
import { canvasIdFor } from './canvas-service.mjs';
import { createIdentityCheckContext } from '../../identity-check-context.mjs';
import { prepareCurrentRoomOutput } from '../../room-output-fence.mjs';

const fail=(status,code,message)=>{throw new RoomError(status,code,message);};

// The BFF owns fresh identity checks and CSRF. The service only accepts its
// trusted actor/session fence; neither account nor session comes from JSON.
export function createCanvasHttp({sessions,rooms,canvases,ready=Promise.resolve(),limit,reply,readJson}={}) {
  if(!sessions?.authorize||!sessions?.checkWrite||!rooms?.getGameContext||!canvases?.read||!canvases?.invalidateAuthorization
      ||![limit,reply,readJson].every(value=>typeof value==='function'))throw new TypeError('Canvas HTTP requires BFF identity and room services');
  return async function route({req,res,url,webRequest}) {
    if(!/^\/api\/rooms\/[^/]+\/canvas(?:\/|$)/.test(url.pathname))return false;
    await ready;
    const match=/^\/api\/rooms\/(\d{6})\/canvas(?:\/(acquire|append|undo|redo|clear))?$/.exec(url.pathname);
    if(!match){reply(res,404,{error:'画布接口不存在。'});return true;}
    const [,code,action]=match,method=action?'POST':'GET';
    if(req.method!==method){reply(res,405,{error:'请求方法不支持。'},{Allow:method});return true;}
    if(url.search)fail(400,'INVALID_CANVAS_QUERY','画布接口不接受额外查询参数。');
    let session;
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    const context = sessions.usesBatchIdentity
      ? createIdentityCheckContext({ now: sessions.now, signal: cancellation.signal }) : null;
    const wait = operation => context ? context.wait(operation) : operation();
    if (context) {
      req.once?.('aborted', abort); res.once?.('close', abort);
      if (req.aborted || res.destroyed || res.writableEnded) abort();
    }
    try {
      session=await sessions.authorize(webRequest,context?{fresh:true,context}:{fresh:true});
      if(!session||typeof session.userKey!=='string'||typeof session.id!=='string')fail(503,'CANVAS_IDENTITY_INVALID','暂时无法核实画笔身份。');
      limit(`canvas-user:${session.userKey}`,180);
      if(action)sessions.checkWrite(webRequest,session);
      const body = action ? await wait(() => readJson(req)) : null;
      const result=await wait(() => action?canvases[action](code,session.userKey,body,{authorizationId:session.id}):canvases.read(code,session.userKey));
      // A commit can succeed before this second fresh authorization fails.
      // Suppress its output and leave recovery to an explicit later read.
      const after=await sessions.authorize(webRequest,context?{fresh:true,touch:false,context}:{fresh:true,touch:false});
      if(!after||['id','userKey','issuer','sub'].some(field => after[field]!==session[field]))fail(401,'CANVAS_IDENTITY_CHANGED','登录身份已变化，请重新确认画布。');
      // A commit made by the original login cannot release its response under
      // a newer same-subject login. Idle renewal preserves this internal hash.
      if(context && after.authorizationLineage!==session.authorizationLineage)throw new IdentityFailure(503);
      const prepare = async () => {
        const current=await wait(() => rooms.getGameContext(code,session.userKey,{includeView:false}));
        const currentId=current.matchId&&current.turnId?canvasIdFor(current.roomId,current.matchId,current.turnId):null;
        if((result.ack??result).canvasId!==currentId)fail(409,'CANVAS_TURN_CHANGED','题目已变化，请读取当前画布。');
        return { guards: [current.roomGuard, current.presenceGuard,...(current.invitationGuard?[current.invitationGuard]:[])] };
      };
      // A room receipt can change while the final guards await storage. Only
      // reprepare this output; the persisted mutation above is never repeated.
      if(context) await prepareCurrentRoomOutput({sessions,session:after,context,prepare,
        refreshSession: () => sessions.authorize(webRequest,{fresh:true,touch:false,context})});
      else await prepare();
      context?.assert();
      reply(res,200,result);return true;
    } catch(error) {
      if(session&&(error.status===401||error.status===503))canvases.invalidateAuthorization(session.id);
      throw error;
    }
    finally {
      if (context) { req.off?.('aborted', abort); res.off?.('close', abort); context.dispose(); }
    }
  };
}
