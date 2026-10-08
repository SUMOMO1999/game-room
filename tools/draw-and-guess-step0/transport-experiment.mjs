// Isolated P1 laboratory. Never imported by production, registered as a game, or
// restored through the production nine-scope backup. All identities are fiction.
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { EncryptedStore, SQLiteAdapter, recordKey } from '../../server/storage.mjs';
import { IdentityPolicyClient, IDENTITY_POLICY_ISSUER } from '../../server/identity-policy-client.mjs';

const FOREVER = Number.MAX_SAFE_INTEGER;
const USERS = ['drawer', ...Array.from({length:7},(_,i)=>`guesser-${i+1}`), ...Array.from({length:8},(_,i)=>`spectator-${i+1}`)];
const ROOM = 'lab-room';
const SCOPES = {room:'lab-draw-room',canvas:'lab-draw-canvas',lease:'lab-draw-lease',presence:'lab-draw-presence',chat:'lab-draw-chat'};
const LIMITS = Object.freeze({points:50000,strokes:1500,canvasBytes:2*1024*1024,batchPoints:256,batchBytes:65536,
  strokePoints:4096,requests:2048,queueEvents:4,queueBytes:256*1024,writerLeaseMs:15000,maxStreams:16,
  pendingWrites:32,pendingWriteBytes:1024*1024});
export { LIMITS, USERS };
const clone = value => structuredClone(value);
const fault = (status,code,message=code) => Object.assign(new Error(message),{status,code});
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const percentile = (samples,p) => samples.length ? [...samples].sort((a,b)=>a-b)[Math.ceil(samples.length*p)-1] : null;
const size = value => Buffer.byteLength(JSON.stringify(value));

// Deliberately local, not a new production adapter. It tests multiple version
// predicates and all writes in one synchronous BEGIN IMMEDIATE transaction.
class LabSQLite extends SQLiteAdapter {
  transaction(changes,guards,clock,validUntil,{beforeCommit}={}) {
    const started=performance.now();this.db.exec('BEGIN IMMEDIATE');
    try {
      const time=clock();
      for(const guard of [...guards,...changes]) {
        const row=this.select.get(guard.key);
        const live=row && row.expiresAt>time;
        if(guard.version===null ? live : !live || row.revision!==guard.version) {this.db.exec('ROLLBACK');return {ok:false,ms:performance.now()-started};}
      }
      if(time>=validUntil) {this.db.exec('ROLLBACK');return {ok:false,ms:performance.now()-started};}
      for(const change of changes) this.write.run(change.key,change.record.revision,change.record.expiresAt,change.record.v,change.record.payload);
      beforeCommit?.();
      if(clock()>=validUntil) {this.db.exec('ROLLBACK');return {ok:false,ms:performance.now()-started};}
      this.db.exec('COMMIT');return {ok:true,ms:performance.now()-started};
    } catch(error) {try {this.db.exec('ROLLBACK');} catch {} throw error;}
  }
}

export async function createCanvasLab({directory,now=Date.now,identityDelayMs=0,eventMode='delta',stageDurationMs=600000,
  beforeTransaction,beforeCommit,watchdogMs=15000,queueEvents=LIMITS.queueEvents,queueBytes=LIMITS.queueBytes}={}) {
  if(!['delta','snapshot'].includes(eventMode)) throw new Error('Unknown laboratory transport');
  const owned=!directory;directory??=mkdtempSync(join(tmpdir(),'draw-step0-'));
  const path=join(directory,'laboratory.sqlite');
  // Public instance identity fences clients against a new temporary laboratory
  // resetting sequence numbers. Adapter reopen keeps this ID; a new object does
  // not. The separate private writer boot below still rotates on restart.
  const bootId=randomUUID();
  // Key is deliberately ephemeral. Recovery tests pass it only through this
  // object; the CLI never reads credentials or writes key material to disk.
  let key=randomBytes(32),adapter=new LabSQLite(path,{now}),storage=new EncryptedStore(adapter,key,now);
  let boot=randomBytes(12).toString('hex'),closed=false,serial=Promise.resolve(),pendingWrites=0,pendingWriteBytes=0;
  const connections=new Set(),buckets=new Map();
  const stats={httpRequests:0,postRequests:0,getRequests:0,httpBytesIn:0,httpBytesOut:0,identityChecks:0,
    identityByPurpose:{},sseEvents:0,sseBytes:0,streamsOpened:0,backpressureDisconnects:0,maxQueuedBytes:0,
    commits:0,conflicts:0,walPeakBytes:0,commitMs:[],ackMs:[],receiveMs:[],pointToReceiveMs:[],batches:0,points:0,
    bodyBytes:[],snapshotBytes:[],transportDeltaBytes:[],requestCounts:{},lockErrors:0,maxQueuedWrites:0,maxQueuedWriteBytes:0};
  const revocations=new Map(USERS.map(user=>[user,false]));
  const auth=async(user,purpose)=> {
    stats.identityChecks++;stats.identityByPurpose[purpose]=(stats.identityByPurpose[purpose]??0)+1;
    // Fresh call every time, including after output network waits. No cache.
    if(identityDelayMs) await sleep(identityDelayMs);
    if(!USERS.includes(user)||revocations.get(user)) throw fault(401,'LAB_IDENTITY_REJECTED');
  };
  const guard=(scope,id,version)=>({key:recordKey(scope,id),version});
  const mutation=(scope,id,record,value)=>({key:recordKey(scope,id),version:record?.version??null,record:storage.encode(scope,id,value,FOREVER)});
  function trackWal() {stats.walPeakBytes=Math.max(stats.walPeakBytes,existsSync(`${path}-wal`)?statSync(`${path}-wal`).size:0);}
  function transact(changes,guards,until=FOREVER) {
    beforeTransaction?.({storage,adapter});
    const result=adapter.transaction(changes,guards,now,until,{beforeCommit});
    stats.commitMs.push(result.ms);if(result.ok) stats.commits++;else stats.conflicts++;trackWal();return result.ok;
  }
  if(!await storage.read(SCOPES.room,ROOM)) {
    await storage.put(SCOPES.room,ROOM,{stage:'drawing',paused:false,deadline:now()+stageDurationMs,drawer:'drawer',turnId:'turn-1'});
    await storage.put(SCOPES.canvas,ROOM,{sequence:0,clearGeneration:0,leaseGeneration:0,strokes:[],undone:[],requests:{}});
    for(const user of USERS) await storage.put(SCOPES.presence,user,{user,active:true});
    await storage.put(SCOPES.chat,ROOM,{sequence:0,messages:[],requests:{}});
  }
  async function member(user) {
    const presence=await storage.read(SCOPES.presence,user);
    if(!presence?.value.active) throw fault(403,'LAB_MEMBER_REQUIRED');return presence;
  }
  async function state(user='drawer') {
    await member(user);
    const [room,canvas]=await Promise.all([storage.read(SCOPES.room,ROOM),storage.read(SCOPES.canvas,ROOM)]);
    if(!room||!canvas) throw fault(503,'LAB_DAMAGED_STATE');return {room,canvas};
  }
  function snapshot(room,canvas) {
    return {bootId,roomId:ROOM,sequence:canvas.sequence,clearGeneration:canvas.clearGeneration,leaseGeneration:canvas.leaseGeneration,
      strokes:clone(canvas.strokes),pointCount:canvas.strokes.reduce((n,stroke)=>n+stroke.points.length,0),stage:room.stage,
      deadline:room.deadline,paused:room.paused,prototype:true};
  }
  async function read(user='drawer') {const {room,canvas}=await state(user);return snapshot(room.value,canvas.value);}
  async function drawing(user) {
    const presence=await member(user),{room,canvas}=await state(user);
    if(user!==room.value.drawer) throw fault(403,'LAB_DRAWER_REQUIRED');
    if(room.value.stage!=='drawing'||room.value.paused||now()>=room.value.deadline) throw fault(409,'LAB_STAGE_CLOSED');
    return {presence,room,canvas};
  }
  const fence=(room,presence,user)=>[guard(SCOPES.room,ROOM,room.version),guard(SCOPES.presence,user,presence.version)];
  async function acquire(user,{deviceId}={}) {
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId??'')) throw fault(400,'LAB_BAD_DEVICE');
    const {presence,room,canvas}=await drawing(user),lease=await storage.read(SCOPES.lease,ROOM);
    const value=clone(canvas.value);value.leaseGeneration++;
    const writer={user,deviceId,generation:value.leaseGeneration,boot,validUntil:Math.min(now()+LIMITS.writerLeaseMs,room.value.deadline)};
    if(!transact([mutation(SCOPES.canvas,ROOM,canvas,value),mutation(SCOPES.lease,ROOM,lease,writer)],fence(room,presence,user),room.value.deadline)) throw fault(409,'LAB_TRANSACTION_CONFLICT');
    await publish('canvas',{kind:'replace',...snapshot(room.value,value)});
    return {bootId,leaseGeneration:value.leaseGeneration,validUntil:writer.validUntil,sequence:value.sequence,clearGeneration:value.clearGeneration};
  }
  function validatedOperations(operations) {
    if(!Array.isArray(operations)||!operations.length||operations.length>16) throw fault(400,'LAB_BAD_BATCH');
    let points=0;
    for(const op of operations) {
      if(!op||Object.keys(op).some(k=>!['strokeId','tool','color','width','points'].includes(k))
        ||!/^[A-Za-z0-9_-]{1,64}$/.test(op.strokeId??'')||!['pen','eraser'].includes(op.tool)
        ||!/^#[0-9a-f]{6}$/i.test(op.color??'')||!Number.isFinite(op.width)||op.width<1||op.width>32
        ||!Array.isArray(op.points)||!op.points.length||op.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!Number.isFinite(n)||n<0||n>1))) throw fault(400,'LAB_BAD_OPERATION');
      points+=op.points.length;
    }
    if(points>LIMITS.batchPoints||size(operations)>LIMITS.batchBytes) throw fault(413,'LAB_BATCH_LIMIT');return points;
  }
  async function edit(user,input,action='append') {
    if(!input||typeof input!=='object'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId??'')) throw fault(400,'LAB_BAD_REQUEST');
    const points=action==='append'?validatedOperations(input.operations):0;
    const {presence,room,canvas}=await drawing(user),lease=await storage.read(SCOPES.lease,ROOM);
    const writer=lease?.value;
    if(!writer||writer.user!==user||writer.deviceId!==input.deviceId||writer.generation!==input.leaseGeneration
      ||writer.boot!==boot||now()>=writer.validUntil) throw fault(409,'LAB_STALE_WRITER');
    const fingerprint=createHash('sha256').update(JSON.stringify([action,input])).digest('hex');
    const previous=canvas.value.requests[input.requestId];
    if(previous) {
      if(previous.fingerprint!==fingerprint) throw fault(409,'LAB_REQUEST_REUSED');
      return {ack:{...previous.ack,bootId,leaseValidUntil:writer.validUntil},duplicate:true};
    }
    if(input.clearGeneration!==canvas.value.clearGeneration) throw fault(409,'LAB_STALE_CLEAR');
    if(input.expectedSequence!==canvas.value.sequence) throw fault(409,'LAB_SEQUENCE_GAP');
    const value=clone(canvas.value);value.sequence++;
    if(action==='append') {
      for(const op of input.operations) {
        const existing=value.strokes.find(stroke=>stroke.strokeId===op.strokeId);
        if(existing) {
          if(existing.tool!==op.tool||existing.color!==op.color||existing.width!==op.width) throw fault(409,'LAB_STROKE_CHANGED');
          existing.points.push(...clone(op.points));
        } else value.strokes.push(clone(op));
      }
      value.undone=[];
    } else if(action==='clear') {value.strokes=[];value.undone=[];value.clearGeneration++;}
    else if(action==='undo') {if(value.strokes.length) value.undone.push(value.strokes.pop());}
    else if(action==='redo') {if(value.undone.length) value.strokes.push(value.undone.pop());}
    if(value.strokes.length>LIMITS.strokes||value.strokes.some(stroke=>stroke.points.length>LIMITS.strokePoints)
      ||[...value.strokes,...value.undone].reduce((n,stroke)=>n+stroke.points.length,0)>LIMITS.points
      ||Object.keys(value.requests).length>=LIMITS.requests) throw fault(413,'LAB_CANVAS_LIMIT');
    const leaseValidUntil=Math.min(now()+LIMITS.writerLeaseMs,room.value.deadline);
    const ack={bootId,roomId:ROOM,sequence:value.sequence,clearGeneration:value.clearGeneration,leaseGeneration:value.leaseGeneration,leaseValidUntil,persisted:true};
    value.requests[input.requestId]={fingerprint,ack};
    if(size(value)>LIMITS.canvasBytes) throw fault(413,'LAB_CANVAS_BYTES');
    const renewed={...writer,validUntil:leaseValidUntil};
    if(!transact([mutation(SCOPES.canvas,ROOM,canvas,value),mutation(SCOPES.lease,ROOM,lease,renewed)],fence(room,presence,user),Math.min(room.value.deadline,writer.validUntil))) throw fault(409,'LAB_TRANSACTION_CONFLICT');
    const snap=snapshot(room.value,value);
    const packet=action==='append'&&eventMode==='delta'?{kind:'append',bootId,roomId:ROOM,sequence:value.sequence,clearGeneration:value.clearGeneration,
      leaseGeneration:value.leaseGeneration,operations:clone(input.operations),pointCount:snap.pointCount,prototype:true}:{kind:'replace',...snap};
    stats.snapshotBytes.push(size(snap));stats.transportDeltaBytes.push(size(packet));
    if(action==='append') {stats.batches++;stats.points+=points;}
    // Commit has returned before any recipient work. Rejected output may leave
    // an unknown committed result; callers must read, never blindly replay.
    await publish('canvas',packet);
    return {ack,duplicate:false};
  }
  function chatPacket(record,user,query={}) {
    const limit=Number(query.limit??100),after=query.after===undefined?undefined:Number(query.after),before=query.before===undefined?undefined:Number(query.before);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||after!==undefined&&(!Number.isSafeInteger(after)||after<0)
      ||before!==undefined&&(!Number.isSafeInteger(before)||before<1)||after!==undefined&&before!==undefined) throw fault(400,'LAB_CHAT_CURSOR');
    let selected=record.messages.filter(message=>(after===undefined||message.chatSequence>after)&&(before===undefined||message.chatSequence<before));
    const hasMore=selected.length>limit;selected=after===undefined?selected.slice(-limit):selected.slice(0,limit);
    return {bootId,roomId:ROOM,messages:selected.map(message=>{const {author,requestId,...safe}=message;return {...safe,...(author===user?{requestId}:{})};}),
      oldestSequence:record.messages[0]?.chatSequence??null,latestSequence:record.sequence,hasMore,historyTruncated:false};
  }
  async function chat(user,input) {
    const presence=await member(user),room=await storage.read(SCOPES.room,ROOM),record=await storage.read(SCOPES.chat,ROOM);
    const text=input?.text?.normalize('NFC');
    if(typeof text!=='string'||!text.trim()||[...text].length>500||size(text)>2048||/\p{Cc}/u.test(text)||!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId??'')) throw fault(400,'LAB_CHAT_INVALID');
    const id=`${user}:${input.requestId}`,prior=record.value.requests[id];
    if(prior) {if(prior.text!==text) throw fault(409,'LAB_REQUEST_REUSED');return {bootId,roomId:ROOM,message:chatPacket({sequence:prior.chatSequence,messages:[prior]},user).messages[0],retained:true,duplicate:true};}
    const value=clone(record.value),message={messageId:randomBytes(16).toString('hex'),chatSequence:++value.sequence,playerId:user,name:user,
      text,sentAt:now(),expiresAt:now()+86400000,author:user,requestId:input.requestId};
    value.messages.push(message);value.messages=value.messages.slice(-500);value.requests[id]=message;
    if(Object.keys(value.requests).length>2048) throw fault(429,'LAB_CHAT_LIMIT');
    // No answer/matcher exists here. This is public synthetic chatter only.
    if(!transact([mutation(SCOPES.chat,ROOM,record,value)],fence(room,presence,user),room.value.deadline)) throw fault(409,'LAB_TRANSACTION_CONFLICT');
    await publish('chat',null);
    return {bootId,roomId:ROOM,message:chatPacket({sequence:value.sequence,messages:[message]},user).messages[0],retained:true};
  }
  async function prepare(connection,type,packet) {
    await auth(connection.user,'sse-delivery');await member(connection.user);
    if(type==='chat') {
      const safe=chatPacket((await storage.read(SCOPES.chat,ROOM)).value,connection.user,connection.chatCursor===null?{}:{after:connection.chatCursor});
      connection.chatCursor=safe.latestSequence;return safe;
    }
    return packet;
  }
  function end(connection) {if(connection.closed)return;connection.closed=true;connections.delete(connection);clearInterval(connection.timer);connection.res.end();}
  async function send(connection,type,packet) {
    if(connection.closed)return;
    // Large snapshots cannot be stuffed into a bounded SSE queue. Give the
    // client an authenticated recovery hint and let its bounded HTTP read fetch
    // the complete <=2 MiB state. This never replays a write.
    if(size(packet??{})+64>queueBytes&&['snapshot','canvas'].includes(type)) {
      packet={bootId,roomId:ROOM,sequence:packet.sequence,clearGeneration:packet.clearGeneration,leaseGeneration:packet.leaseGeneration,requiresRead:true,prototype:true};type='recovery';
    }
    const estimated=size(packet??{})+64;
    if(++connection.queued>queueEvents||(connection.bytes+=estimated)>queueBytes) {stats.backpressureDisconnects++;end(connection);return;}
    stats.maxQueuedBytes=Math.max(stats.maxQueuedBytes,connection.bytes);
    connection.flight=connection.flight.then(async()=>{
      if(connection.closed)return;
      const safe=await prepare(connection,type,packet);
      if(connection.closed)return;
      const frame=`event: ${type}\ndata: ${JSON.stringify(safe)}\n\n`;
      if(connection.res.writableLength+Buffer.byteLength(frame)>queueBytes) {stats.backpressureDisconnects++;end(connection);return;}
      stats.sseEvents++;stats.sseBytes+=Buffer.byteLength(frame);connection.res.write(frame);
    }).catch(()=>end(connection)).finally(()=>{connection.queued--;connection.bytes-=estimated;});
    return connection.flight;
  }
  async function publish(type,packet) {await Promise.all([...connections].map(connection=>send(connection,type,packet)));}
  function rate(user,ip) {
    const at=now();for(const [label,max] of [[`ip:${ip}`,240],[`user:${user}`,120]]) {
      const old=buckets.get(label),bucket=old&&at-old.since<60000?old:{since:at,count:0};buckets.set(label,bucket);
      stats.requestCounts[label]=(stats.requestCounts[label]??0)+1;
      if(++bucket.count>max) throw fault(429,'LAB_RATE_LIMIT');
    }
  }
  async function body(req) {
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')) throw fault(415,'LAB_JSON_REQUIRED');
    const chunks=[];let bytes=0;for await(const chunk of req) {bytes+=chunk.length;if(bytes>LIMITS.batchBytes)throw fault(413,'LAB_BODY_LIMIT');chunks.push(chunk);}
    stats.httpBytesIn+=bytes;stats.bodyBytes.push(bytes);
    try {const value=JSON.parse(Buffer.concat(chunks));if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}
    catch {throw fault(400,'LAB_JSON_INVALID');}
  }
  function reply(res,status,value) {if(res.headersSent){res.end();return;}const payload=JSON.stringify(value);stats.httpBytesOut+=Buffer.byteLength(payload);
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(payload);}
  async function handle(req,res) {
    const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/lab/'))return false;
    const begun=performance.now(),user=String(req.headers['x-lab-user']??url.searchParams.get('labUser')??'drawer');
    stats.httpRequests++;if(req.method==='POST')stats.postRequests++;else stats.getRequests++;
    try {
      if(closed)throw fault(503,'LAB_CLOSED');
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw fault(403,'LAB_LOOPBACK_ONLY');
      if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)throw fault(403,'LAB_ORIGIN_REJECTED');
      // Simulated IP is a synthetic scenario annotation, never client identity.
      rate(user,String(req.headers['x-lab-ip']??req.socket.remoteAddress));
      await auth(user,'http-pre');await member(user);
      if(url.pathname==='/lab/events'&&req.method==='GET') {
        if(connections.size>=LIMITS.maxStreams)throw fault(429,'LAB_STREAM_LIMIT');
        const connection={user,res,queued:0,bytes:0,closed:false,chatCursor:null,flight:Promise.resolve(),timer:null};
        connections.add(connection);stats.streamsOpened++;res.on('close',()=>end(connection));
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders();
        await send(connection,'snapshot',await read(user));await send(connection,'chat',null);
        if(watchdogMs>0) {connection.timer=setInterval(()=>{auth(user,'sse-watchdog').then(()=>member(user)).catch(()=>end(connection));},watchdogMs);connection.timer.unref();}
        return true;
      }
      let result;
      if(req.method==='GET'&&url.pathname==='/lab/read')result=await read(user);
      else if(req.method==='GET'&&url.pathname==='/lab/chat')result=chatPacket((await storage.read(SCOPES.chat,ROOM)).value,user,Object.fromEntries(url.searchParams.entries()));
      else if(req.method==='POST') {
        const input=await body(req),action=url.pathname.slice(5);
        const inputBytes=size(input);
        if(pendingWrites>=LIMITS.pendingWrites||pendingWriteBytes+inputBytes>LIMITS.pendingWriteBytes)throw fault(429,'LAB_WRITE_QUEUE_FULL');
        pendingWrites++;pendingWriteBytes+=inputBytes;
        stats.maxQueuedWrites=Math.max(stats.maxQueuedWrites,pendingWrites);stats.maxQueuedWriteBytes=Math.max(stats.maxQueuedWriteBytes,pendingWriteBytes);
        // Serialize only this laboratory's calls. SQLite version fences remain
        // necessary for a second connection or async mutation before BEGIN.
        const execute=async()=>{
          if(action==='acquire')return acquire(user,input);
          if(['append','clear','undo','redo'].includes(action))return edit(user,input,action);
          if(action==='chat')return chat(user,input);
          if(action==='guess') {if(!user.startsWith('guesser-'))throw fault(403,'LAB_GUESSER_REQUIRED');return {bootId,prototype:true,accepted:false,code:'LAB_MATCHER_NOT_IMPLEMENTED'};}
          throw fault(404,'LAB_NOT_FOUND');
        };
        const flight=serial.then(execute);serial=flight.catch(()=>{});
        try {result=await flight;} finally {pendingWrites--;pendingWriteBytes-=inputBytes;}
      } else throw fault(404,'LAB_NOT_FOUND');
      await auth(user,'http-output');await member(user);
      stats.ackMs.push(performance.now()-begun);reply(res,200,result);
    } catch(error) {if(/locked|busy/i.test(error.message))stats.lockErrors++;reply(res,error.status??503,{error:error.code??'LAB_UNAVAILABLE',prototype:true});}
    return true;
  }
  async function control(change={}) {
    const room=await storage.read(SCOPES.room,ROOM);
    if(change.room)await storage.replaceCAS(SCOPES.room,ROOM,room.version,{...room.value,...change.room},FOREVER);
    if(change.presence) {const old=await storage.read(SCOPES.presence,change.presence.user);await storage.replaceCAS(SCOPES.presence,change.presence.user,old.version,change.presence,FOREVER);}
    if(change.revoke)revocations.set(change.revoke,true);
  }
  async function restart() {
    await serial;for(const connection of [...connections])end(connection);storage.close();
    adapter=new LabSQLite(path,{now});storage=new EncryptedStore(adapter,key,now);boot=randomBytes(12).toString('hex');
  }
  function metrics() {
    trackWal();return {...clone(stats),activeStreams:connections.size,databaseBytes:statSync(path).size,sqliteVersion:adapter.db.prepare('SELECT sqlite_version() AS v').get().v,
      journalMode:adapter.db.prepare('PRAGMA journal_mode').get().journal_mode,limits:LIMITS,
      commitP50Ms:percentile(stats.commitMs,.5),commitP95Ms:percentile(stats.commitMs,.95),ackP95Ms:percentile(stats.ackMs,.95)};
  }
  async function backup() {
    await serial;const destination=join(directory,`lab-backup-${randomBytes(4).toString('hex')}.sqlite`),begun=performance.now();
    adapter.db.exec(`VACUUM INTO '${destination.replaceAll("'","''")}'`);
    const restored=new EncryptedStore(new LabSQLite(destination,{now}),key,now);
    try {const saved=await restored.read(SCOPES.canvas,ROOM);return {ms:performance.now()-begun,bytes:statSync(destination).size,sequence:saved.value.sequence,pointCount:saved.value.strokes.reduce((n,s)=>n+s.points.length,0)};}
    finally {restored.close();rmSync(destination,{force:true});}
  }
  async function close() {closed=true;for(const connection of [...connections])end(connection);await serial;storage.close();if(owned)rmSync(directory,{recursive:true,force:true});}
  return {handle,close,read,acquire,edit,chat,control,restart,backup,metrics,inspect:()=>({storage,adapter,path,boot,bootId}),publish};
}

export async function createExperimentServer(options={}) {
  const lab=await createCanvasLab(options),server=http.createServer(async(req,res)=>{if(!await lab.handle(req,res)){res.writeHead(404);res.end();}});
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=64;
  try {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  catch(error){await lab.close();throw error;}
  return {lab,server,origin:`http://127.0.0.1:${server.address().port}`,close:async()=>{await lab.close();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}};
}

export function deterministicTrace(index,count) {
  return Array.from({length:count},(_,i)=>{const n=index+i;return [Math.round((.5+.42*Math.sin(n*.017))*10000)/10000,Math.round((.5+.38*Math.cos(n*.029))*10000)/10000];});
}

export async function runIdentityBurstProbe() {
  // Actual unchanged E3 client, virtual scheduler, synthetic strict six-field
  // responses. No request reaches the real endpoint. Model 50ms provider time.
  const base=1800000000000;let time=base,timerId=0,sent=0;
  const timers=new Map(),latencies=[],results=[];
  const scheduler={setTimeout(callback,delay){const id=++timerId;timers.set(id,{callback,at:time+delay});return id;},clearTimeout(id){timers.delete(id);}};
  const identities=USERS.map((user,i)=>({issuer:IDENTITY_POLICY_ISSUER,sub:`fictional-step0-${user}`,clientId:'fictionalstep0client1234',
    authTime:base/1000-20,expiresAt:base+60000,accessToken:`fictional-step0-token-${i}`}));
  const adapter=new IdentityPolicyClient({now:()=>time,scheduler,fetcher:async(url,options)=>{
    sent++;const who=identities.find(identity=>options.headers.Authorization===`Bearer ${identity.accessToken}`);
    await new Promise(resolve=>scheduler.setTimeout(resolve,50));
    return Response.json({version:1,revokedBefore:0,issuer:who.issuer,sub:who.sub,clientId:who.clientId,authTime:who.authTime});
  }});
  const launched=[];
  for(let step=0;step<=600;step++) {
    time=base+step*10;
    if(step===0||step===100)for(const identity of identities) {
      const begun=time;launched.push(adapter.check(identity).then(()=>{results.push('ok');latencies.push(time-begun);},()=>results.push('503')));
    }
    for(;;) {const next=[...timers].filter(([,entry])=>entry.at<=time).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);next[1].callback();}
    for(let i=0;i<16;i++)await Promise.resolve();
  }
  await Promise.all(launched);
  return {equivalentMs:6000,logicalChecks:32,actualSyntheticUpstreamSends:sent,ok:results.filter(value=>value==='ok').length,
    unavailable:results.filter(value=>value==='503').length,authorizationP50Ms:percentile(latencies,.5),authorizationP95Ms:percentile(latencies,.95),
    exactTokenInflightMergingPreserved:true,positiveSuccessCache:false,syntheticProviderMs:50};
}

async function scenario({seconds,batchMs,eventMode='delta',rooms=1,oneIp=true}) {
  let virtual=1800000000000;const start=virtual,systems=[];const wall=performance.now(),cpu=process.cpuUsage(),memory=process.memoryUsage();
  let rssPeak=memory.rss,totalRequests=0;const deliveries=[],pointAges=[],controllers=[];const pendingReaders=[];
  try {
    for(let room=0;room<rooms;room++) {
      const system=await createExperimentServer({now:()=>virtual,eventMode,watchdogMs:0,stageDurationMs:(seconds+30)*1000});systems.push(system);
      system.messages=[];system.controllers=new Map();
      system.openStream=async(user)=>{
        const controller=new AbortController();controllers.push(controller);
        system.controllers.set(user,controller);
        const response=await fetch(`${system.origin}/lab/events?labUser=${user}`,{headers:{'x-lab-ip':oneIp?'shared-ip':user},signal:controller.signal});
        if(!response.ok)throw new Error(`Stream opening ${response.status} ${await response.text()}`);
        const reader=(async()=>{const decoder=new TextDecoder();let carry='';for await(const chunk of response.body) {
          carry+=decoder.decode(chunk,{stream:true});let boundary;
          while((boundary=carry.indexOf('\n\n'))!==-1) {const frame=carry.slice(0,boundary);carry=carry.slice(boundary+2);
            if(frame.startsWith('event: recovery')) {
              const recovered=await fetch(`${system.origin}/lab/read?labUser=${user}`,{headers:{'x-lab-ip':oneIp?'shared-ip':user}});
              if(!recovered.ok)throw new Error(`Recovery ${recovered.status}`);const snapshot=await recovered.json();system.recoveredPoints=snapshot.pointCount;
              continue;
            }
            if(!frame.startsWith('event: canvas'))continue;
            const packet=JSON.parse(frame.slice(frame.indexOf('data: ')+6));system.messages.push({user,sequence:packet.sequence,at:performance.now()});
          }
        }})().catch(error=>{if(error.name!=='AbortError')throw error;});pendingReaders.push(reader);
      };
      for(const user of USERS) await system.openStream(user);
      const response=await fetch(`${system.origin}/lab/acquire?labUser=drawer`,{method:'POST',headers:{'Content-Type':'application/json','x-lab-ip':oneIp?'shared-ip':'drawer'},body:JSON.stringify({deviceId:'trace-device'})});
      if(!response.ok)throw new Error(`Acquire ${response.status}`);system.lease=await response.json();system.sequence=0;system.clear=0;
    }
    const ticks=Math.ceil(seconds*1000/batchMs),pointBatch=Math.round(60*batchMs/1000);
    const request=async(system,user,path,body)=> {
      totalRequests++;const response=await fetch(`${system.origin}/lab/${path}?labUser=${user}`,{method:'POST',headers:{'Content-Type':'application/json','x-lab-ip':oneIp?'shared-ip':user},body:JSON.stringify(body)});
      const result=await response.json();if(!response.ok)throw new Error(`${path} ${response.status} ${result.error}`);return result;
    };
    for(let tick=0;tick<ticks;tick++) {
      virtual=start+(tick+1)*batchMs;
      for(const system of systems) {
        if(tick===Math.floor(ticks/2)) {
          system.controllers.get('spectator-8').abort();
          const until=performance.now()+1000;
          while(system.lab.metrics().activeStreams>=16) {if(performance.now()>until)throw new Error('Old stream did not close');await sleep(1);}
          await system.openStream('spectator-8');
        }
        const begun=performance.now(),target=system.sequence+1;
        const result=await request(system,'drawer','append',{deviceId:'trace-device',leaseGeneration:system.lease.leaseGeneration,clearGeneration:system.clear,
          expectedSequence:system.sequence,requestId:`batch-${tick}`,operations:[{strokeId:`stroke-${Math.floor(tick*batchMs/2000)}`,tool:'pen',color:'#245c7c',width:4,points:deterministicTrace(tick*pointBatch,pointBatch)}]});
        system.sequence=result.ack.sequence;
        // Wait for all 16 actual SSE parsers. A stuck stream is a hard failure.
        const until=performance.now()+2000;
        while(system.messages.filter(message=>message.sequence===target).length<16) {if(performance.now()>until)throw new Error('SSE receive timeout');await sleep(1);}
        for(const message of system.messages.filter(message=>message.sequence===target)) {
          const latency=message.at-begun;deliveries.push(latency);
          for(let i=0;i<pointBatch;i++)pointAges.push(latency+batchMs-(i+.5)*1000/60);
        }
        if(tick>0&&Math.floor((tick+1)*batchMs/10000)>Math.floor(tick*batchMs/10000)) {
          for(const user of USERS.filter(u=>u.startsWith('guesser')))await request(system,user,'guess',{requestId:`guess-${tick}`,text:'虚构猜词'});
        }
        if(tick>0&&Math.floor((tick+1)*batchMs/15000)>Math.floor(tick*batchMs/15000)) {
          for(const user of USERS.slice(0,8))await request(system,user,'chat',{requestId:`chat-${tick}`,text:'合成负载消息'});
        }
      }
      rssPeak=Math.max(rssPeak,process.memoryUsage().rss);
    }
    const backups=await Promise.all(systems.map(system=>system.lab.backup()));
    const measurements=systems.map(system=>system.lab.metrics());
    const summed=label=>measurements.reduce((n,m)=>n+m[label],0);
    const checks=summed('identityChecks'),watchdogs=rooms*USERS.length*Math.floor(seconds/15),identityWithWatchdogs=checks+watchdogs;
    return {scenario:{seconds,batchMs,eventMode,rooms,oneIp,pointsPerSecond:60},wallMs:performance.now()-wall,cpuMs:(process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000,
      rssBaselineBytes:memory.rss,rssPeakBytes:rssPeak,rssEndBytes:process.memoryUsage().rss,httpRequests:summed('httpRequests'),postRequests:summed('postRequests'),getRequests:summed('getRequests'),
      actualIdentityChecks:checks,identityChecksWithEquivalentWatchdogs:identityWithWatchdogs,identityChecksPerEquivalentSecond:identityWithWatchdogs/seconds,
      equivalentWatchdogsNotWallClock:watchdogs,sseEvents:summed('sseEvents'),sseBytes:summed('sseBytes'),httpBytesIn:summed('httpBytesIn'),httpBytesOut:summed('httpBytesOut'),
      actualSseReceiveP50Ms:percentile(deliveries,.5),actualSseReceiveP95Ms:percentile(deliveries,.95),equivalentPointToReceiveP50Ms:percentile(pointAges,.5),equivalentPointToReceiveP95Ms:percentile(pointAges,.95),
      local4RpsOverloadRatio:identityWithWatchdogs/seconds/4,centralShared5RpsOverloadRatio:identityWithWatchdogs/seconds/5,
      backups,measurements:measurements.map(m=>({...m,commitMs:undefined,ackMs:undefined,receiveMs:undefined,pointToReceiveMs:undefined,bodyBytes:undefined,snapshotBytes:undefined,transportDeltaBytes:undefined,
        bodyP95Bytes:percentile(m.bodyBytes,.95),snapshotP95Bytes:percentile(m.snapshotBytes,.95),deltaP95Bytes:percentile(m.transportDeltaBytes,.95)}))};
  } finally {
    controllers.forEach(controller=>controller.abort());await Promise.allSettled(pendingReaders);await Promise.all(systems.map(system=>system.close()));
  }
}

export async function runTransportExperiment() {
  const scenarios=[];
  for(const config of [{seconds:120,batchMs:1000},{seconds:600,batchMs:1000},{seconds:120,batchMs:600},
    {seconds:120,batchMs:1000,eventMode:'snapshot'},{seconds:120,batchMs:1000,rooms:2,oneIp:false}]) scenarios.push(await scenario(config));
  return {version:1,prototype:true,generatedAt:new Date().toISOString(),node:process.version,identityBurst:await runIdentityBurstProbe(),scenarios,
    gate:'P1_BLOCKED',identity:'Fresh synthetic authorization calls; no real Agora/provider/network calls. Existing 4 rps scheduler and shared 5 rps limits are arithmetic capacity gates, not removed or passed.'};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  if(process.argv.length!==2)throw new Error('Usage: node tools/draw-and-guess-step0/transport-experiment.mjs');
  console.log(JSON.stringify(await runTransportExperiment(),null,2));
}
