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
import { publicAssetPaths } from './public-assets.mjs';

const root = fileURLToPath(new URL('../app/', import.meta.url));
const files = new Set(publicAssetPaths());
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const baseHeaders = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
const reauthHref='https://agora.sumomoli.com/#account';
const message = error => error instanceof RoomError ? error.message : error.status===401 ? '棋牌登录已失效，请重新登录。' : error.status===403 ? '这次操作未通过安全验证，请刷新后重试。' : '暂时无法确认登录状态，请稍后重试。';
async function readJson(req) {
  if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw new RoomError(415,'JSON_REQUIRED','请求需要 JSON 格式。');
  if(req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length'])>32768)) {req.resume();throw new RoomError(413,'BODY_TOO_LARGE','请求内容过大。');}
  let size=0;const chunks=[];
  for await(const chunk of req) {size+=chunk.length;if(size>32768) {req.resume();throw new RoomError(413,'BODY_TOO_LARGE','请求内容过大。');}chunks.push(chunk);}
  try {const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error();return value;}
  catch {throw new RoomError(400,'INVALID_JSON','请求内容不是有效的 JSON 对象。');}
}
export function createUnifiedServer(options) {
  const runtime=options.sessions && options.rooms ? options : createRuntime(options.settings,options);
  const {settings,sessions,rooms,storage,chat}=runtime;
  const configuredEntries=makeEntries(settings,options.entries);
  if(!configuredEntries.some(entry=>entry.direct)) throw new TypeError('The original direct game entry must remain enabled');
  // Explicit dual-entry configuration is immutable. The legacy one-entry API
  // still supports local fixtures assigning their actual ephemeral listen port.
  const entries=options.entries===undefined?null:configuredEntries;
  const preview=runtime.preview || createRoomPreview(options.previewOptions);
  const history=runtime.history || createMatchHistory({storage,now:storage.now});
  rooms.setHistory?.(history);
  // Startup recovery may fail temporarily; the committed room outbox remains retryable.
  const historyRecovery=Promise.resolve().then(()=>rooms.flushPendingRecords?.()).catch(()=>{});
  const security={...baseHeaders,...(settings.production?{'Strict-Transport-Security':'max-age=31536000'}:{})};
  const accountPublic={mode:settings.mode,loginReady:sessions.loginReady,reauthReady:settings.mode==='cognito',...(settings.mode==='cognito'?{reauthHref}:{})};
  const connections=new Set();const buckets=new Map();
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
  const unsubscribeInvalidation=sessions.subscribeInvalidation(({sessionId,status})=>{preview.clearSession(sessionId);for(const connection of connections) if(connection.id===sessionId) connection.end(status);});
  const viewSignature=value=>{const {serverTime,...stable}=value || {};return JSON.stringify(stable);};
  async function stream(webRequest,res,code,session,roomId,withPreview=false) {
    let alive=true,unsubscribe=null,unsubscribeChat=null,unsubscribePreview=null,heartbeat=null,watchdog=null,queue=Promise.resolve(),queued=0,checking=false,pendingView=null,viewQueued=false,lastViewSignature=null,previewQueued=false,previewDirty=false,lastPreviewSignature=null;
    const connection={id:session.id,end(status=404,error) {
      if(!alive) return;alive=false;pendingView=null;connections.delete(connection);clearInterval(heartbeat);clearInterval(watchdog);
      Promise.resolve(unsubscribe?.()).catch(()=>{});
      Promise.resolve(unsubscribeChat?.()).catch(()=>{});
      unsubscribePreview?.();
      // A null status is only transport backpressure: EOF uses the client's
      // existing reconnect path. Identity failures still send 401/503 below.
      if(status!==null && !res.destroyed && res.headersSent && !res.writableEnded) res.write(`event: closed\ndata: ${JSON.stringify({status,error:error || message({status})})}\n\n`);
      res.end();
    }};
    const check=()=>sessions.authorize(webRequest,{touch:false});
    const enqueue=(type,value)=>{
      if(!alive) return;
      if(++queued>4) {queued--;connection.end(null);return;}
      queue=queue.then(async()=>{
        if(!alive) return;
        // Pending views are superseded by the latest committed room state.
        // Chat packets remain ordered and are never collapsed or replayed.
        if(type==='view') {pendingView=null;value=await rooms.getView(code,session.userKey);}
        else if(type==='preview') {previewDirty=false;await rooms.getView(code,session.userKey);}
        else {await rooms.getView(code,session.userKey);value=await chat.preparePacket(code,session.userKey,value);}
        await check();
        // Online checks can wait. Fence the project seat again after that wait;
        // a valid shared account cannot authorize an already abandoned seat.
        const liveView=await rooms.getView(code,session.userKey);
        if(liveView.roomId!==roomId || value?.roomId && value.roomId!==roomId) throw new RoomError(404,'ROOM_NOT_FOUND','原房间已关闭，请重新进入。');
        if(type==='view') {value=liveView;lastViewSignature=viewSignature(value);}
        if(type==='preview') {
          value=preview.packet(liveView,{forStream:true});
          const signature=JSON.stringify(value);
          if(signature===lastPreviewSignature) return;
          lastPreviewSignature=signature;
        }
        if(!alive || res.destroyed) return;
        if(res.writableLength>524288) {connection.end(null);return;}
        res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      }).catch(error=>connection.end(error.status===401?401:error.status===403 || error.status===404?404:503))
        .finally(()=>{queued--;if(type==='view') {viewQueued=false;if(pendingView && alive && viewSignature(pendingView)!==lastViewSignature) send('view',pendingView);else pendingView=null;}
          if(type==='preview') {previewQueued=false;if(previewDirty && alive) send('preview');}});
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
      unsubscribe=await rooms.subscribe(code,session.userKey,view=>{if(withPreview) preview.observe(view);send('view',view);},(error,status=404)=>connection.end(status,error));
      if(!alive) {await unsubscribe();return;}
      if(chat) {
        unsubscribeChat=await chat.subscribe(code,session.userKey,value=>send('chat',value),(error,status=404)=>connection.end(status===403?404:status,error));
        if(!alive) {await unsubscribeChat();await unsubscribe();return;}
      }
      if(withPreview) {
        const liveView=await rooms.getView(code,session.userKey);
        if(liveView.gameType==='rummikub') {
          unsubscribePreview=preview.subscribe(liveView,session.id,()=>send('preview'));
          // Initial/reconnected observers obtain the latest safe snapshot only
          // after their own online identity check and final seat fence.
          send('preview'); // Even an empty initial snapshot establishes a silent audio baseline.
        }
      }
      heartbeat=setInterval(()=>{if(alive && !res.destroyed) res.write(': ping\n\n');},options.heartbeatMs || 20000);heartbeat.unref();
      watchdog=setInterval(()=>{
        if(!alive || checking) return;checking=true;
        // This check cannot wait behind private event preparation or sending.
        Promise.resolve().then(()=>{if(alive) return check();}).catch(error=>connection.end(error.status===401?401:503)).finally(()=>{checking=false;});
      },options.watchdogMs || 15000);watchdog.unref();
    } catch(error) {connection.end(error.status || 503,message(error));}
  }
  const server=http.createServer(async(req,res)=>{
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
      if(url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) limit(`ip:${clientAddress}`);
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
        const profile=await rooms.ensureProfile(session.userKey),recentRooms=await rooms.recentRooms(session.userKey);
        await sessions.authorize(webRequest,{touch:false});
        return reply(res,200,{...accountPublic,loginReady:true,authenticated:true,userKey:session.userKey,csrf:session.csrf,expiresAt:session.expiresAt,idleUntil:session.idleUntil,profile:{nickname:profile.nickname},recentRooms});
      }
      if(url.pathname==='/api/profile') {
        if(req.method!=='PUT') return reply(res,405,{error:'请使用 PUT。'},{Allow:'PUT'});
        const body=await readJson(req);if(Object.keys(body).some(key=>key!=='nickname')) throw new RoomError(400,'INVALID_BODY','只需要棋牌昵称。');
        const session=await sessions.authorize(webRequest,{fresh:true});sessions.checkWrite(webRequest,session);
        const profile=await rooms.setProfile(session.userKey,body.nickname);await sessions.authorize(webRequest,{touch:false});
        return reply(res,200,{profile:{nickname:profile.nickname}});
      }
      if(url.pathname==='/api/history') {
        if(req.method!=='GET') return reply(res,405,{error:'请使用 GET。'},{Allow:'GET'});
        const session=await sessions.authorize(webRequest,{fresh:true});limit(`user:${session.userKey}`,120);
        const query=historyQuery(url.searchParams);
        await rooms.flushPendingRecords?.();
        const result=await history.get(session.userKey,query);
        await sessions.authorize(webRequest,{touch:false});
        return reply(res,200,result);
      }
      if(url.pathname.startsWith('/api/rooms')) {
        const route=/^\/api\/rooms\/(\d{6})(?:\/(join|events|actions|chat|preview))?$/.exec(url.pathname),create=url.pathname==='/api/rooms';
        if(!create && !route) return reply(res,404,{error:'接口不存在。'});
        const [,code,endpoint]=route || [],write=create || endpoint==='join' || endpoint==='actions' || ['chat','preview'].includes(endpoint) && req.method==='POST',method=write?'POST':'GET';
        if(req.method!==method) return reply(res,405,{error:'请求方法不支持。'},{Allow:['chat','preview'].includes(endpoint)?'GET, POST':method});
        const body=write?await readJson(req):null;
        let permit=null;
        if(endpoint==='preview') {
          const cookie=requestCookie(webRequest,entry.cookieName);
          // A forged cookie cannot exhaust the optional publication budget.
          // This local existence check grants no identity or seat: E3 still
          // runs independently before and after preparing any public packet.
          let known=false;
          if(cookie) {try {known=!storage.read || !!await storage.read('sessions',cookie);} catch {preview.clearSession(cookie);throw new IdentityFailure(503);}}
          if(known) permit=preview.reserve(code,{read:!write});
        }
        const session=await sessions.authorize(webRequest,{fresh:write});limit(`user:${session.userKey}`,120);if(write) sessions.checkWrite(webRequest,session);
        if(endpoint==='events') {const initialView=await rooms.getView(code,session.userKey);return await stream(webRequest,res,code,session,initialView.roomId,url.searchParams.get('preview')==='1');}
        if(endpoint==='preview') {
          const initialView=await rooms.getView(code,session.userKey);
          if(initialView.gameType!=='rummikub' || !['friends-v1','friends-v2','friends-v3','friends-v4'].includes(initialView.game?.ruleVersion)) throw new RoomError(400,'PREVIEW_UNSUPPORTED','本游戏没有桌面整理预览。');
          const prepared=write?preview.prepare(initialView,body,session.id):null;
          await sessions.authorize(webRequest,{touch:false});
          const liveView=await rooms.getView(code,session.userKey);
          if(initialView.roomId!==liveView.roomId) throw new RoomError(404,'ROOM_NOT_FOUND','原房间已关闭，请重新进入。');
          return reply(res,200,write?preview.commit(prepared,liveView,permit):preview.packet(liveView));
        }
        let result;
        if(endpoint==='chat') {
          if(!chat) throw new RoomError(503,'CHAT_UNAVAILABLE','聊天暂时不可用。');
          result=write?await chat.send(code,session.userKey,body):await chat.get(code,session.userKey,chatQuery(url.searchParams));
        } else if(write) {
          if(create || endpoint==='join') {
            const fields=create?['name','requestId','gameType']:['name','requestId','role'];
            if(Object.keys(body).some(key=>!fields.includes(key))) throw new RoomError(400,'INVALID_BODY','创建只需要称呼、游戏类型和请求编号；加入使用已有房间的游戏。');
            limit(`${create?'create':'join'}:${session.userKey}`,create?20:40);
            result=create?await rooms.createRoom(session.userKey,body.name,body.requestId,body.gameType):await rooms.joinRoom(code,session.userKey,body.name,body.requestId,body.role);
          } else result=await rooms.action(code,session.userKey,body);
        } else result={view:await rooms.getView(code,session.userKey)};
        await sessions.authorize(webRequest,{touch:false});
        if(result?.left) {
          preview.clearSession(session.id);
          try {await rooms.getView(code,session.userKey);} catch(error) {if(error.code==='ROOM_NOT_FOUND') preview.forgetRoom(code);}
        }
        // A central check does not grant a room seat. Recheck membership after
        // the network wait; an explicit successful leave has no private view.
        if(!result?.left) {
          const currentView=await rooms.getView(result?.roomCode || code,session.userKey);
          if((result?.view?.roomId || result?.roomId)!==currentView.roomId) throw new RoomError(404,'ROOM_NOT_FOUND','原房间已关闭，请重新进入。');
          if(endpoint!=='chat') result={...result,...(result.playerId?{playerId:currentView.selfId}:{}),view:currentView};
        }
        return reply(res,create || endpoint==='join'?201:200,result);
      }
      if(url.pathname.startsWith('/api/')) return reply(res,404,{error:'接口不存在。'});
      if(!['GET','HEAD'].includes(req.method)) return reply(res,405,{error:'请求方法不支持。'},{Allow:'GET, HEAD'});
      const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!files.has(filename)) return reply(res,404,{error:'页面不存在。'});
      const body=await readFile(path.join(root,filename));res.writeHead(200,{...security,'Content-Type':mime[path.extname(filename)]});res.end(req.method==='HEAD'?undefined:body);
    } catch(error) {
      const known=error instanceof RoomError || error instanceof IdentityFailure;
      reply(res,known?error.status:503,{error:known?message(error):'服务暂时无法完成操作。',code:known?error.code:'SERVICE_UNAVAILABLE',
        ...(error.retryAfter?{retryAfter:error.retryAfter}:{}),...(error.code==='PREVIEW_RATE_LIMIT'?{minIntervalMs:error.minIntervalMs,nextAllowedAt:error.nextAllowedAt}:{})},error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});
    }
  });
  let cleanupPromise;
  let sweepFlight=Promise.resolve();
  const sweep=setInterval(()=>{
    sweepFlight=sweepFlight.then(async()=>{
      if(cleanupPromise) return;
      await rooms.sweep();
      await chat?.sweep();
      preview.sweep();
      storage?.adapter?.purgeExpired?.(storage.now());
    }).catch(()=>{});
  },60000);sweep.unref();
  function cleanup() {
    if(!cleanupPromise) {
      clearInterval(sweep);unsubscribeInvalidation();for(const connection of [...connections]) connection.end(503);
      preview.close();
      cleanupPromise=sweepFlight.then(()=>historyRecovery).then(async()=>{
        try {await chat?.close();} finally {await rooms.close();}
      }).finally(()=>storage?.close());
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
