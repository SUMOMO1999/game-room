import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isIP } from 'node:net';
import { RoomError } from '../app/rooms.mjs';
import { IdentityFailure } from './auth.mjs';
import { requestCookie } from './session-service.mjs';
import { createRuntime } from './runtime.mjs';
import { chatQuery } from './chat.mjs';
import { createMatchHistory, historyQuery } from './match-history.mjs';
import { safeReturnTo } from './config.mjs';
import { createRoomPreview } from './room-preview.mjs';
import { makeEntries, resolveEntry, bindEntry, entryPath } from './entry-context.mjs';
import { createIdentityCheckContext, bindIdentityCheckContext, unbindIdentityCheckContext } from './identity-check-context.mjs';
import { prepareCurrentRoomOutput } from './room-output-fence.mjs';
import { publicAssetPaths } from './public-assets.mjs';
import { createWordbankHttp } from './content/wordbank-http.mjs';
import { createCanvasHttp } from './games/draw-and-guess/canvas-http.mjs';
import { WordbankError } from './content/draw-and-guess-wordbank.mjs';
import { createGameScoresHttp } from './game-scores-http.mjs';
import { createGameScores } from './game-scores.mjs';

const root = fileURLToPath(new URL('../app/', import.meta.url));
const files = new Set(publicAssetPaths());
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const baseHeaders = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
const reauthHref='https://agora.sumomoli.com/#account';
const publicCanvasWatchdogMs=15000,publicCanvasLeaseMs=25000;
// Only these public ink shapes may use the canvas-only watchdog lease. Exact
// nested fields keep future private metadata on the ordinary fresh path.
function publicCanvasPacket(value) {
  const exact=(item,keys)=>item && typeof item==='object' && !Array.isArray(item)
    && Object.keys(item).length===keys.length && keys.every(key=>Object.hasOwn(item,key));
  const integer=value=>Number.isSafeInteger(value) && value>=0;
  const token=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const common=['kind','bootId','canvasId','roomId','matchId','turnId','sequence','clearGeneration','leaseGeneration'];
  const snapshot=['snapshot','replace'].includes(value?.kind);
  const keys=snapshot?[...common,'stage','deadline','paused','geometry','strokes','pointCount']
    :value?.kind==='append'?[...common,'operations','pointCount']:value?.kind==='recovery'?[...common,'requiresRead']:null;
  if(!keys || !exact(value,keys) || typeof value.bootId!=='string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.bootId)
    || typeof value.roomId!=='string' || !/^[a-f0-9]{32}$/.test(value.roomId)
    || ![value.sequence,value.clearGeneration,value.leaseGeneration].every(integer)) return false;
  const empty=value.canvasId===null && value.matchId===null && value.turnId===null;
  if(!empty && (typeof value.canvasId!=='string' || !/^[a-f0-9]{64}$/.test(value.canvasId)
    || typeof value.matchId!=='string' || !/^[a-f0-9]{32}$/.test(value.matchId) || !token(value.turnId))) return false;
  if(value.kind==='recovery') return !empty && value.requiresRead===true;
  if(!integer(value.pointCount) || value.pointCount>50000) return false;
  if(snapshot && (!token(value.stage) || value.deadline!==null && !Number.isFinite(value.deadline)
    || typeof value.paused!=='boolean' || !exact(value.geometry,['width','height'])
    || value.geometry.width!==1024 || ![576,768].includes(value.geometry.height))) return false;
  const strokes=snapshot?value.strokes:value.operations;
  if(!Array.isArray(strokes) || strokes.length>(snapshot?1500:16) || !snapshot && (!strokes.length || empty)) return false;
  let points=0;
  for(const stroke of strokes) {
    if(!exact(stroke,['strokeId','tool','color','width','points']) || !token(stroke.strokeId)
      || !['pen','eraser'].includes(stroke.tool) || typeof stroke.color!=='string' || !/^#[a-f0-9]{6}$/i.test(stroke.color)
      || !Number.isFinite(stroke.width) || stroke.width<1 || stroke.width>32 || !Array.isArray(stroke.points)
      || !stroke.points.length || stroke.points.length>4096
      || stroke.points.some(point=>!Array.isArray(point) || point.length!==2 || point.some(n=>!Number.isFinite(n) || n<0 || n>1))) return false;
    points+=stroke.points.length;
  }
  return points<=(snapshot?50000:256) && (!snapshot || points===value.pointCount)
    && (!empty || !strokes.length && [value.sequence,value.clearGeneration,value.leaseGeneration,value.pointCount].every(n=>n===0));
}
const message = error => error instanceof RoomError ? error.message : error.status===401 ? '棋牌登录已失效，请重新登录。' : error.status===403 ? '这次操作未通过安全验证，请刷新后重试。' : '暂时无法确认登录状态，请稍后重试。';
async function readJson(req, maxBytes = 32768) {
  if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw new RoomError(415,'JSON_REQUIRED','请求需要 JSON 格式。');
  if(req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length'])>maxBytes)) {req.resume();throw new RoomError(413,'BODY_TOO_LARGE','请求内容过大。');}
  let size=0;const chunks=[];
  for await(const chunk of req) {size+=chunk.length;if(size>maxBytes) {req.resume();throw new RoomError(413,'BODY_TOO_LARGE','请求内容过大。');}chunks.push(chunk);}
  try {const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error();return value;}
  catch {throw new RoomError(400,'INVALID_JSON','请求内容不是有效的 JSON 对象。');}
}
export function createUnifiedServer(options) {
  const runtime=options.sessions && options.rooms ? options : createRuntime(options.settings,options);
  const {settings,sessions,rooms,storage,chat,wordbanks,wordbankReady,canvases,drawingEnabled=false,poker414Enabled=false}=runtime;
  const configuredEntries=makeEntries(settings,options.entries);
  if(!configuredEntries.some(entry=>entry.direct)) throw new TypeError('The original direct game entry must remain enabled');
  // Explicit dual-entry configuration is immutable. The legacy one-entry API
  // still supports local fixtures assigning their actual ephemeral listen port.
  const entries=options.entries===undefined?null:configuredEntries;
  const preview=runtime.preview || createRoomPreview(options.previewOptions);
  const history=runtime.history || createMatchHistory({storage,now:storage.now,gameRegistry:runtime.gameRegistry});
  rooms.setHistory?.(history);
  // Startup recovery may fail temporarily; the committed room outbox remains retryable.
  const historyRecovery=Promise.resolve().then(()=>rooms.flushPendingRecords?.()).catch(()=>{});
  const security={...baseHeaders,...(settings.production?{'Strict-Transport-Security':'max-age=31536000'}:{})};
  const accountPublic={mode:settings.mode,loginReady:sessions.loginReady,drawingEnabled,poker414Enabled,reauthReady:settings.mode==='cognito',...(settings.mode==='cognito'?{reauthHref}:{})};
  const connections=new Set();const buckets=new Map();
  let queuedCanvasBytes=0;
  const maxQueuedCanvasBytes=2*1024*1024;
  function limit(key,maximum=240) {
    const now=Date.now(),old=buckets.get(key);const bucket=old && now-old.since<60000?old:{since:now,count:0};buckets.set(key,bucket);
    if(++bucket.count>maximum) throw new RoomError(429,'RATE_LIMIT','操作太频繁，请稍后再试。');
    if(buckets.size>2048) {for(const [id,item] of buckets) if(now-item.since>=60000) buckets.delete(id);if(buckets.size>2048) buckets.delete(buckets.keys().next().value);}
  }
  function reply(res,status,body,extra={}) {
    if(res.destroyed || res.writableEnded) return;if(res.headersSent) {res.end();return;}
    // Header names are case-insensitive on the wire. Normalize overrides so
    // auth responses do not emit duplicate Cache-Control or security headers.
    const headers=Object.fromEntries(Object.entries({...security,'Content-Type':'application/json; charset=utf-8'}).map(([name,value])=>[name.toLowerCase(),value]));
    for(const [name,value] of Object.entries(extra)) headers[name.toLowerCase()]=value;
    res.writeHead(status,headers);res.end(body===null?undefined:JSON.stringify(body));
  }
  const wordbankRoute = wordbanks && drawingEnabled ? createWordbankHttp({sessions,rooms,wordbanks,ready:wordbankReady,limit,reply,readJson:req=>readJson(req,65536)}) : null;
  const canvasRoute = canvases && drawingEnabled ? createCanvasHttp({sessions,rooms,canvases,limit,reply,readJson}) : null;
  let scoresRoute = null;
  const unsubscribeInvalidation=sessions.subscribeInvalidation(({sessionId,userKey,status})=>{preview.clearSession(sessionId);if(userKey) canvases?.invalidateActor(userKey);canvases?.invalidateAuthorization?.(sessionId);for(const connection of connections) if(connection.id===sessionId) connection.end(status);});
  const viewSignature=value=>{const {serverTime,...stable}=value || {};return JSON.stringify(stable);};
  async function stream(webRequest,res,code,session,roomId,withPreview=false,setupContext=null) {
    if (res.destroyed || res.writableEnded) return;
    let alive=true,unsubscribe=null,unsubscribeChat=null,unsubscribePreview=null,unsubscribeCanvas=null,heartbeat=null,watchdog=null,queue=Promise.resolve(),canvasQueue=Promise.resolve(),queued=0,checking=false,pendingView=null,viewQueued=false,lastViewSignature=null,previewQueued=false,previewDirty=false,lastPreviewSignature=null;
    const cancellation = new AbortController();
    let canvasLease=null,canvasLeaseGeneration=0,legacyCanvas=false;
    const identityNow=typeof sessions.now==='function'?sessions.now:Date.now;
    const assertCanvasLease=lease=>{
      if(!alive || !lease || identityNow()>=lease.validUntil || performance.now()-lease.monotonicStart>=publicCanvasLeaseMs)
        throw new IdentityFailure(503);
    };
    const boundSession=authorized=>{
      if(!authorized || ['id','userKey','issuer','sub'].some(field=>authorized[field]!==session[field])) throw new IdentityFailure();
    };
    const refreshCanvasLease=async()=>{
      const generation=++canvasLeaseGeneration,monotonicStart=performance.now();
      const context=createIdentityCheckContext({now:identityNow,signal:cancellation.signal});
      try {
        let authorized=await context.wait(()=>sessions.authorize(webRequest,{fresh:true,touch:false,context,signal:cancellation.signal}));
        // Legacy identity upgrades can commit a new record without returning
        // its version. One readonly fresh recheck stays in the original budget.
        if(authorized.authorizationVersion===undefined)
          authorized=await context.wait(()=>sessions.authorize(webRequest,{fresh:true,touch:false,context,signal:cancellation.signal}));
        boundSession(authorized);
        if(authorized.authorizationVersion===undefined || !/^[a-f0-9]{64}$/.test(authorized.authorizationLineage ?? '')
          || !Number.isFinite(authorized.expiresAt) || !Number.isFinite(authorized.idleUntil)
          || canvasLease && authorized.authorizationLineage!==canvasLease.session.authorizationLineage) throw new IdentityFailure(503);
        const lease={session:authorized,monotonicStart,
          validUntil:Math.min(context.triggeredAtMs+publicCanvasLeaseMs,authorized.expiresAt,authorized.idleUntil)};
        assertCanvasLease(lease);context.assert();
        if(generation!==canvasLeaseGeneration) throw new IdentityFailure(503);
        canvasLease=lease;
      } finally {context.dispose();}
    };
    const currentCanvasSession=async lease=>{
      assertCanvasLease(lease);
      const record=await sessions.store.read('sessions',lease.session.id);
      assertCanvasLease(lease);
      if(!record || record.value.phase!=='active') throw new IdentityFailure();
      const current=sessions.publicSession(lease.session.id,record.value,record.version);
      boundSession(current);
      if(current.authorizationLineage!==lease.session.authorizationLineage) throw new IdentityFailure(503);
      if(!Number.isFinite(current.expiresAt) || !Number.isFinite(current.idleUntil)
        || identityNow()>=Math.min(current.expiresAt,current.idleUntil)) throw new IdentityFailure();
      return current;
    };
    const prepare = operation => setupContext ? setupContext.wait(operation) : operation();
    // A cancelled setup can finish externally later. Its eventual subscription
    // still belongs to this connection and must be closed after it really exists.
    const subscribe = (operation, setOwner) => prepare(async () => {
      const stop = await operation();
      let stopped;
      const unsubscribe = () => stopped ??= Promise.resolve().then(stop);
      // Transfer ownership synchronously before a surrounding wait can reject.
      // A close between these awaits must still find the actual subscription.
      setOwner(unsubscribe);
      if (!alive) await unsubscribe();
      return unsubscribe;
    });
    const connection={id:session.id,end(status=404,error) {
      if(!alive) return;alive=false;canvasLease=null;canvasLeaseGeneration++;pendingView=null;connections.delete(connection);clearInterval(heartbeat);clearInterval(watchdog);
      cancellation.abort();
      Promise.resolve(unsubscribe?.()).catch(()=>{});
      Promise.resolve(unsubscribeChat?.()).catch(()=>{});
      unsubscribePreview?.();
      Promise.resolve(unsubscribeCanvas?.()).catch(()=>{});
      // A null status is only transport backpressure: EOF uses the client's
      // existing reconnect path. Identity failures still send 401/503 below.
      if(status!==null && !res.destroyed && res.headersSent && !res.writableEnded) res.write(`event: closed\ndata: ${JSON.stringify({status,error:error || message({status})})}\n\n`);
      res.end();
    }};
    const check=async context=>{
      if(!sessions.usesBatchIdentity) return sessions.authorize(webRequest,{touch:false});
      const owned=context?null:createIdentityCheckContext({now:sessions.now,signal:cancellation.signal});
      try {return await sessions.authorize(webRequest,{touch:false,signal:cancellation.signal,context:context || owned});}
      finally {owned?.dispose();}
    };
    const enqueue=(type,value)=>{
      if(!alive) return;
      const originalValue=value;
      if(++queued>4) {queued--;connection.end(null);return;}
      const canvasPayload=type==='canvas'?JSON.stringify(value):null;
      const publicPacket=legacyCanvas && type==='canvas'?JSON.parse(canvasPayload):null;
      const lease=publicPacket && publicCanvasPacket(publicPacket)?canvasLease:null;
      if(lease) value=publicPacket;
      const canvasBytes=canvasPayload===null?0:Buffer.byteLength(canvasPayload);
      if(queuedCanvasBytes+canvasBytes>maxQueuedCanvasBytes) {queued--;connection.end(null);return;}
      queuedCanvasBytes+=canvasBytes;
      // Collection and queueing are part of the original event budget. Creating
      // this only when its turn starts would give an old packet another 8 seconds.
      const context = sessions.usesBatchIdentity || lease
        ? createIdentityCheckContext({ now: sessions.now, signal: cancellation.signal,
          ...(lease?{timeoutMs:Math.max(1,Math.min(8000,Math.floor(lease.validUntil-identityNow())))}:{}) }) : null;
      const wait = async operation => {
        if(lease) assertCanvasLease(lease);
        const result=await (context?context.wait(operation):operation());
        if(lease) assertCanvasLease(lease);
        return result;
      };
      // Ink has its own ordered delivery lane. A slow view/chat preparation
      // must not hold already committed strokes behind unrelated private
      // projections. Both lanes keep the same connection budget, cancellation
      // and fresh/final authority fences; legacy delivery remains serial.
      const inkLane = sessions.usesBatchIdentity && context && type==='canvas';
      const next = (inkLane ? canvasQueue : queue).then(async()=>{
        if(!alive) return;
        // These are independent readonly prerequisites for this queued event.
        // Start fresh identity work only at its queue head, within its original
        // context. Observe errors immediately even if room preparation fails;
        // cancellation still leaves actual unfinished work owned by the client.
        const authentication = context && !lease
          ? check(context).then(session => ({ session }), error => ({ error })) : null;
        // Pending views are superseded by the latest committed room state.
        // Chat packets remain ordered and are never collapsed or replayed.
        if(type==='view') {
          pendingView=null;
          if(context) await wait(() => rooms.getGameContext(code,session.userKey,{includeView:false}));
          else value=await wait(() => rooms.getView(code,session.userKey));
        }
        else if(type==='preview') {previewDirty=false;await wait(() => rooms.getView(code,session.userKey));}
        else if(type==='canvas') {
          await wait(() => context ? rooms.getGameContext(code,session.userKey,{includeView:false}) : rooms.getView(code,session.userKey));
        }
        else {
          await wait(() => type==='chat' && context ? rooms.getGameContext(code,session.userKey,{includeView:false}) : rooms.getView(code,session.userKey));
          value=await wait(() => chat.preparePacket(code,session.userKey,value));
        }
        let authorized;
        if(authentication) {
          const result = await wait(() => authentication);
          if('error' in result) throw result.error;
          authorized = result.session;
        } else authorized = lease?await wait(()=>currentCanvasSession(lease)):await check(context);
        if(['id','userKey','issuer','sub'].some(field => authorized[field]!==session[field])) throw new IdentityFailure();
        // A still-active record for the same subject may belong to a new
        // login. Each packet remains bound to the connection's activation.
        if(context && !lease && authorized.authorizationLineage!==session.authorizationLineage) throw new IdentityFailure(503);
        // Online checks can wait. Fence the project seat again after that wait;
        // a valid shared account cannot authorize an already abandoned seat.
        const prepare=async attempt=>{
          const authorityOnly=type==='canvas' || type==='chat';
          const outputContext = context ? await wait(() => rooms.getGameContext(code,session.userKey,{includeView:!authorityOnly})) : null;
          // Batch chat and canvas need current authority, not a discarded
          // private game projection. Other events and legacy keep full views.
          const liveView=authorityOnly && outputContext ? null : outputContext?.view ?? await wait(() => rooms.getView(code,session.userKey));
          const liveRoom=authorityOnly && outputContext ? outputContext : liveView;
          if(liveRoom.roomId!==roomId || value?.roomId && value.roomId!==roomId) throw new RoomError(404,'ROOM_NOT_FOUND','原房间已关闭，请重新进入。');
          let outputValue=type==='view'?liveView:value,signature=null;
          if(type==='canvas') {
            const gameType=outputContext ? outputContext.gameType : liveView.gameType;
            const turnId=outputContext ? outputContext.turnId : liveView.game?.turnId ?? null;
            if(gameType!=='draw-and-guess' || value.bootId!==canvases.bootId
              || value.matchId!==liveRoom.matchId || value.turnId!==turnId) return null;
          }
          // Fresh can outlast a message's retention. Refilter the original
          // ordered packet for every batch output attempt, including the first.
          if(type==='chat' && context) outputValue=await wait(() => chat.preparePacket(code,session.userKey,originalValue));
          if(type==='preview') {
            outputValue=preview.packet(liveView,{forStream:true});signature=JSON.stringify(outputValue);
            if(signature===lastPreviewSignature) return null;
          }
          if(type==='view') signature=viewSignature(outputValue);
          if(!alive || res.destroyed || res.writableEnded) return null;
          if(res.writableLength>524288) {connection.end(null);return null;}
          return { signature, payload:canvasPayload ?? JSON.stringify(outputValue),
            guards: outputContext?[outputContext.roomGuard,outputContext.presenceGuard,...(outputContext.invitationGuard?[outputContext.invitationGuard]:[])]:[] };
        };
        const output=context?await prepareCurrentRoomOutput({sessions,session:authorized,context,prepare,
          refreshSession: () => lease?wait(()=>currentCanvasSession(lease)):check(context)}):await prepare(0);
        if(!output) return;
        if(!alive || res.destroyed || res.writableEnded) return;
        context?.assert();
        if(lease) assertCanvasLease(lease);
        // A rejected first fence must not mark an undelivered view/preview as
        // delivered, or the single readonly recheck could suppress its packet.
        if(type==='view') lastViewSignature=output.signature;
        if(type==='preview') lastPreviewSignature=output.signature;
        res.write(`event: ${type}\ndata: ${output.payload}\n\n`);
      }).catch(error=>connection.end(error.status===401?401:error.status===403 || error.status===404?404:503))
        .finally(()=>{context?.dispose();queued--;queuedCanvasBytes-=canvasBytes;if(type==='view') {viewQueued=false;if(pendingView && alive && viewSignature(pendingView)!==lastViewSignature) send('view',pendingView);else pendingView=null;}
          if(type==='preview') {previewQueued=false;if(previewDirty && alive) send('preview');}});
      if(inkLane) canvasQueue=next;else queue=next;
    };
    const send=(type,value)=>{
      if(!alive) return;
      if(type==='preview') {previewDirty=true;if(previewQueued) return;previewQueued=true;enqueue(type);return;}
      if(type!=='view') {enqueue(type,value);return;}
      if(viewSignature(value)===lastViewSignature) return;
      pendingView=value;
      if(viewQueued) return;
      viewQueued=true;enqueue('view',value);
    };
    connections.add(connection);res.on('close',()=>connection.end());
    res.writeHead(200,{...security,'Content-Type':'text/event-stream; charset=utf-8',Connection:'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    try {
      unsubscribe=await subscribe(() => rooms.subscribe(code,session.userKey,view=>{if(withPreview) preview.observe(view);send('view',view);},(error,status=404)=>connection.end(status,error)),value=>{unsubscribe=value;});
      if(!alive) {await unsubscribe();return;}
      if(chat) {
        unsubscribeChat=await subscribe(() => chat.subscribe(code,session.userKey,value=>send('chat',value),(error,status=404)=>connection.end(status===403?404:status,error)),value=>{unsubscribeChat=value;});
        if(!alive) {await unsubscribeChat();await unsubscribe();return;}
      }
      if(withPreview) {
        const liveView=await prepare(() => rooms.getView(code,session.userKey));
        if(liveView.gameType==='rummikub') {
          unsubscribePreview=preview.subscribe(liveView,session.id,()=>send('preview'));
          // Initial/reconnected observers obtain the latest safe snapshot only
          // after their own online identity check and final seat fence.
          send('preview'); // Even an empty initial snapshot establishes a silent audio baseline.
        }
      }
      if(canvases) {
        const liveView=await prepare(() => rooms.getView(code,session.userKey));
        if(liveView.gameType==='draw-and-guess') {
          legacyCanvas=!sessions.usesBatchIdentity && typeof rooms.getGameContext==='function'
            && typeof sessions.assertCurrent==='function' && typeof sessions.publicSession==='function'
            && typeof sessions.store?.read==='function';
          if(legacyCanvas) await refreshCanvasLease();
          unsubscribeCanvas=await subscribe(() => canvases.watch(code,session.userKey,value=>send('canvas',value),(error,status=503)=>connection.end(status,error)),value=>{unsubscribeCanvas=value;});
          if(!alive) {await unsubscribeCanvas();return;}
        }
      }
      setupContext?.assert();
      if(!alive || res.destroyed || res.writableEnded) {connection.end(null);return;}
      heartbeat=setInterval(()=>{if(alive && !res.destroyed) res.write(': ping\n\n');},options.heartbeatMs || 20000);heartbeat.unref();
      watchdog=setInterval(()=>{
        if(!alive || checking) return;checking=true;
        // This check cannot wait behind private event preparation or sending.
        Promise.resolve().then(()=>{if(alive) return legacyCanvas?refreshCanvasLease():check();}).catch(error=>connection.end(error.status===401?401:503)).finally(()=>{checking=false;});
      },legacyCanvas?Math.min(options.watchdogMs || publicCanvasWatchdogMs,publicCanvasWatchdogMs):options.watchdogMs || 15000);watchdog.unref();
    } catch(error) {connection.end(error.status || 503,message(error));}
  }
  const server=http.createServer(async(req,res)=>{
    let identityContext = null, identityRequest = null, cancelRequest = null;
    try {
      let context;try {context=resolveEntry(req,entries || makeEntries(settings));} catch {throw new RoomError(403,'INVALID_HOST','请通过已配置的棋牌入口访问。');}
      const {entry,externalUrl,logicalPath}=context;
      const url=new URL(logicalPath+externalUrl.search,entry.origin);
      if(url.origin!==entry.origin || req.headers['sec-fetch-site']==='cross-site' && url.pathname.startsWith('/api/')) throw new IdentityFailure(403,'invalid_origin');
      if(req.headers.origin && req.headers.origin!==entry.origin) throw new IdentityFailure(403,'invalid_origin');
      const webRequest=new Request(externalUrl,{method:req.method,headers:req.headers});
      bindEntry(webRequest,entry,logicalPath);
      res.gameEntry=entry;
      const peer=req.headers['x-game-room-peer'];
      const localPeer=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const clientAddress=settings.production && localPeer && typeof peer==='string' && isIP(peer)?peer:req.socket.remoteAddress;
      const canvasPath=/^\/api\/rooms\/\d{6}\/canvas(?:\/(?:acquire|append|undo|redo|clear))?$/.test(url.pathname);
      if(canvasPath) {limit(`canvas-ip:${clientAddress}`,360);limit('canvas-global',300);}
      else if(url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) limit(`ip:${clientAddress}`);
      if(url.pathname==='/healthz') {
        if(!['GET','HEAD'].includes(req.method)) return reply(res,405,{error:'请使用 GET。'},{Allow:'GET, HEAD'});
        await storage.adapter.get('health-check');
        return reply(res,200,req.method==='HEAD'?null:{ok:true});
      }
      if(url.pathname.startsWith('/api/') && (req.headers.authorization || [...url.searchParams.keys()].some(key=>['token','authorization','userKey','playerId'].includes(key)))) throw new RoomError(400,'CLIENT_CREDENTIAL_FORBIDDEN','棋牌身份由登录会话确认。');
      const auth=await sessions.route(webRequest);
      if(auth) {
        if(url.pathname==='/auth/callback' && auth.status>=400) {
          const target=new URL(safeReturnTo(auth.body?.returnTo,entry.origin),entry.origin);
          target.searchParams.set('login',auth.status===409 && auth.body?.error==='account_switch_requires_logout'?'account':auth.status===503?'unavailable':auth.status===401 && settings.mode==='cognito'?'verify':'retry');
          return reply(res,303,null,{...auth.headers,location:entryPath(entry,target.pathname)+target.search});
        }
        return reply(res,auth.status,auth.body,auth.headers);
      }
      if(canvasRoute && await canvasRoute({req,res,url,webRequest})) return;
      if(sessions.usesBatchIdentity && url.pathname.startsWith('/api/')) {
        const cancellation = new AbortController();
        cancelRequest = () => cancellation.abort();
        identityContext = createIdentityCheckContext({ now: sessions.now, signal: cancellation.signal,
          timeoutMs: Math.min(8000,sessions.authorizationTimeoutMs) });
        bindIdentityCheckContext(webRequest,identityContext);
        identityRequest=webRequest;
        req.once('aborted',cancelRequest);res.once('close',cancelRequest);
        if(req.aborted || res.destroyed || res.writableEnded) cancelRequest();
      }
      const wait = operation => identityContext ? identityContext.wait(operation) : operation();
      const fence = async (session,guards=[]) => {
        if(identityContext) { await sessions.assertCurrent(session,{context:identityContext,guards});identityContext.assert(); }
      };
      if(wordbankRoute && await wait(() => wordbankRoute({req,res,url,webRequest}))) return;
      if(/^\/api\/rooms\/[^/]+\/scores(?:\/|$)/.test(url.pathname)) {
        scoresRoute ??= createGameScoresHttp({ sessions, rooms, scores: runtime.scores || createGameScores({ storage, now: storage.now }), limit, reply });
        if(await wait(() => scoresRoute({req,res,url,webRequest}))) return;
      }
      if(url.pathname==='/api/entry-status') {
        if(req.method!=='GET') return reply(res,405,{error:'请使用 GET。'},{Allow:'GET'});
        if(url.search) return reply(res,400,{error:'invalid_entry_request',code:'invalid_entry_request'});
        try {return reply(res,200,await sessions.entryStatus(webRequest));}
        catch(error) {
          // The fixed front door consumes status only; never transfer cookies,
          // profile/room data, or session secrets in this read-only response.
          const status=error instanceof IdentityFailure?error.status:503;
          return reply(res,status,{error:error instanceof IdentityFailure?error.code:'identity_unavailable',code:error instanceof IdentityFailure?error.code:'identity_unavailable'});
        }
      }
      if(url.pathname==='/api/state') {
        if(req.method!=='GET') return reply(res,405,{error:'请使用 GET。'},{Allow:'GET'});
        if(!requestCookie(webRequest,entry.cookieName)) return reply(res,200,{...accountPublic,authenticated:false});
        let session;try {session=await sessions.authorize(webRequest,{fresh:true});} catch(error) {
          // A delayed old-cookie check must not erase a newer login Cookie.
          if(error.status===401) return reply(res,200,{...accountPublic,authenticated:false});throw error;
        }
        const profile=await wait(() => rooms.ensureProfile(session.userKey)),recentRooms=await wait(() => rooms.recentRooms(session.userKey));
        const after=await sessions.authorize(webRequest,{touch:false});await fence(after);
        return reply(res,200,{...accountPublic,loginReady:true,authenticated:true,userKey:session.userKey,csrf:session.csrf,expiresAt:session.expiresAt,idleUntil:session.idleUntil,profile:{nickname:profile.nickname},recentRooms});
      }
      if(url.pathname==='/api/profile') {
        if(req.method!=='PUT') return reply(res,405,{error:'请使用 PUT。'},{Allow:'PUT'});
        const body=await wait(() => readJson(req));if(Object.keys(body).some(key=>key!=='nickname')) throw new RoomError(400,'INVALID_BODY','只需要棋牌昵称。');
        const session=await sessions.authorize(webRequest,{fresh:true});sessions.checkWrite(webRequest,session);
        const profile=await wait(() => rooms.setProfile(session.userKey,body.nickname));const after=await sessions.authorize(webRequest,{touch:false});await fence(after);
        return reply(res,200,{profile:{nickname:profile.nickname}});
      }
      if(url.pathname==='/api/history') {
        if(req.method!=='GET') return reply(res,405,{error:'请使用 GET。'},{Allow:'GET'});
        const session=await sessions.authorize(webRequest,{fresh:true});limit(`user:${session.userKey}`,120);
        const query=historyQuery(url.searchParams);
        await wait(() => rooms.flushPendingRecords?.());
        const result=await wait(() => history.get(session.userKey,query));
        const after=await sessions.authorize(webRequest,{touch:false});await fence(after);
        return reply(res,200,result);
      }
      if(url.pathname.startsWith('/api/rooms')) {
        const route=/^\/api\/rooms\/(\d{6})(?:\/(join|events|actions|chat|preview))?$/.exec(url.pathname),create=url.pathname==='/api/rooms';
        if(!create && !route) return reply(res,404,{error:'接口不存在。'});
        const [,code,endpoint]=route || [],write=create || endpoint==='join' || endpoint==='actions' || ['chat','preview'].includes(endpoint) && req.method==='POST',method=write?'POST':'GET';
        if(req.method!==method) return reply(res,405,{error:'请求方法不支持。'},{Allow:['chat','preview'].includes(endpoint)?'GET, POST':method});
        const body=write?await wait(() => readJson(req)):null;
        let permit=null;
        if(endpoint==='preview') {
          const cookie=requestCookie(webRequest,entry.cookieName);
          // A forged cookie cannot exhaust the optional publication budget.
          // This local existence check grants no identity or seat: E3 still
          // runs independently before and after preparing any public packet.
          let known=false;
          if(cookie) {try {known=!storage.read || !!await wait(() => storage.read('sessions',cookie));} catch {preview.clearSession(cookie);throw new IdentityFailure(503);}}
          if(known) permit=preview.reserve(code,{read:!write});
        }
        const session=await sessions.authorize(webRequest,{fresh:write});limit(`user:${session.userKey}`,120);if(write) sessions.checkWrite(webRequest,session);
        if(endpoint==='events') {
          const initialView=await wait(() => rooms.getView(code,session.userKey));
          // A stream owns new per-event contexts after this initial request.
          // Its handshake context must not be reused for the connection lifetime.
          return await stream(webRequest,res,code,session,initialView.roomId,url.searchParams.get('preview')==='1',identityContext);
        }
        if(endpoint==='preview') {
          const initialView=await wait(() => rooms.getView(code,session.userKey));
          if(initialView.gameType!=='rummikub' || !['friends-v1','friends-v2','friends-v3','friends-v4'].includes(initialView.game?.ruleVersion)) throw new RoomError(400,'PREVIEW_UNSUPPORTED','本游戏没有桌面整理预览。');
          const prepared=write?preview.prepare(initialView,body,session.id):null;
          const after=await sessions.authorize(webRequest,{touch:false});
          const outputContext=identityContext?await wait(() => rooms.getGameContext(code,session.userKey)):null;
          const liveView=outputContext?.view ?? await wait(() => rooms.getView(code,session.userKey));
          if(initialView.roomId!==liveView.roomId) throw new RoomError(404,'ROOM_NOT_FOUND','原房间已关闭，请重新进入。');
          await fence(after,outputContext?[outputContext.roomGuard,outputContext.presenceGuard,...(outputContext.invitationGuard?[outputContext.invitationGuard]:[])]:[]);
          return reply(res,200,write?preview.commit(prepared,liveView,permit):preview.packet(liveView));
        }
        let result;
        if(endpoint==='chat') {
          if(!chat) throw new RoomError(503,'CHAT_UNAVAILABLE','聊天暂时不可用。');
          result=await wait(() => write?chat.send(code,session.userKey,body):chat.get(code,session.userKey,chatQuery(url.searchParams)));
        } else if(write) {
          if(create || endpoint==='join') {
            const fields=create?['name','requestId','gameType']:['name','requestId','role'];
            if(Object.keys(body).some(key=>!fields.includes(key))) throw new RoomError(400,'INVALID_BODY','创建只需要称呼、游戏类型和请求编号；加入使用已有房间的游戏。');
            limit(`${create?'create':'join'}:${session.userKey}`,create?20:40);
            result=await wait(() => create?rooms.createRoom(session.userKey,body.name,body.requestId,body.gameType):rooms.joinRoom(code,session.userKey,body.name,body.requestId,body.role));
          } else result=await wait(() => rooms.action(code,session.userKey,body));
        } else result={view:await wait(() => rooms.getView(code,session.userKey))};
        const after=await sessions.authorize(webRequest,{touch:false});
        if(identityContext && endpoint==='chat' && write) {
          if(!after || ['id','userKey','issuer','sub'].some(field=>after[field]!==session[field])) throw new IdentityFailure();
          if(after.authorizationLineage!==session.authorizationLineage) throw new IdentityFailure(503);
          // Sending has already committed. Only reprepare its original ACK's
          // room authority; a failed output must never repeat chat.send.
          const prepare=async()=>{
            const current=await wait(() => rooms.getGameContext(code,session.userKey,{includeView:false}));
            if(result.roomId!==current.roomId) throw new RoomError(404,'ROOM_NOT_FOUND','原房间已关闭，请重新进入。');
            return { guards: [current.roomGuard,current.presenceGuard,...(current.invitationGuard?[current.invitationGuard]:[])] };
          };
          // Ordinary HTTP keeps its original authorization: session conflicts
          // have no fresh callback and remain failures under the same deadline.
          await prepareCurrentRoomOutput({sessions,session:after,context:identityContext,prepare});
          identityContext.assert();
          return reply(res,200,result);
        }
        let outputContext=null;
        if(result?.left) {
          preview.clearSession(session.id);
          try {await wait(() => rooms.getView(code,session.userKey));} catch(error) {if(error.code==='ROOM_NOT_FOUND') preview.forgetRoom(code);}
        }
        // A central check does not grant a room seat. Recheck membership after
        // the network wait; an explicit successful leave has no private view.
        if(!result?.left) {
          outputContext=identityContext?await wait(() => rooms.getGameContext(result?.roomCode || code,session.userKey)):null;
          const currentView=outputContext?.view ?? await wait(() => rooms.getView(result?.roomCode || code,session.userKey));
          if((result?.view?.roomId || result?.roomId)!==currentView.roomId) throw new RoomError(404,'ROOM_NOT_FOUND','原房间已关闭，请重新进入。');
          if(endpoint!=='chat') result={...result,...(result.playerId?{playerId:currentView.selfId}:{}),view:currentView};
        }
        await fence(after,outputContext?[outputContext.roomGuard,outputContext.presenceGuard,...(outputContext.invitationGuard?[outputContext.invitationGuard]:[])]:[]);
        return reply(res,create || endpoint==='join'?201:200,result);
      }
      if(url.pathname.startsWith('/api/')) return reply(res,404,{error:'接口不存在。'});
      if(!['GET','HEAD'].includes(req.method)) return reply(res,405,{error:'请求方法不支持。'},{Allow:'GET, HEAD'});
      const filename=url.pathname==='/'?'index.html':url.pathname==='/words'?'words.html':url.pathname.slice(1);if(!files.has(filename)) return reply(res,404,{error:'页面不存在。'});
      const body=await readFile(path.join(root,filename));res.writeHead(200,{...security,'Content-Type':mime[path.extname(filename)]});res.end(req.method==='HEAD'?undefined:body);
    } catch(error) {
      const known=error instanceof RoomError || error instanceof IdentityFailure || error instanceof WordbankError;
      reply(res,known?error.status:503,{error:known?(error instanceof WordbankError?error.message:message(error)):'服务暂时无法完成操作。',code:known?error.code:'SERVICE_UNAVAILABLE',
        ...(error.retryAfter?{retryAfter:error.retryAfter}:{}),...(error.code==='PREVIEW_RATE_LIMIT'?{minIntervalMs:error.minIntervalMs,nextAllowedAt:error.nextAllowedAt}:{})},error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});
    }
    finally {
      if(cancelRequest) {req.off('aborted',cancelRequest);res.off('close',cancelRequest);}
      if(identityRequest) unbindIdentityCheckContext(identityRequest,identityContext);
      identityContext?.dispose();
    }
  });
  let cleanupPromise;
  let sweepFlight=Promise.resolve();
  const sweep=setInterval(()=>{
    sweepFlight=sweepFlight.then(async()=>{
      if(cleanupPromise) return;
      await rooms.sweep();
      await chat?.sweep();
      await canvases?.sweep();
      preview.sweep();
      storage?.adapter?.purgeExpired?.(storage.now());
    }).catch(()=>{});
  },60000);sweep.unref();
  function cleanup() {
    if(!cleanupPromise) {
      clearInterval(sweep);unsubscribeInvalidation();for(const connection of [...connections]) connection.end(503);
      preview.close();
      cleanupPromise=sweepFlight.then(()=>historyRecovery).then(async()=>{
        await canvases?.close();
        try {await chat?.close();} finally {await rooms.close();}
      }).finally(async()=>{try {await runtime.identityRuntime?.close();} finally {storage?.close();}});
    }
    return cleanupPromise;
  }
  server.on('close',()=>{cleanup().catch(()=>{});});
  server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  server.shutdown=async()=>{
    for(const connection of [...connections]) connection.end(503);server.closeIdleConnections();
    try {await new Promise((resolve,reject)=>server.close(error=>error && error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));}
    finally {await cleanup();}
  };
  return server;
}
