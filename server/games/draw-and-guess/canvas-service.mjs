import { createHash, randomUUID } from 'node:crypto';
import { RoomError } from '../../../app/rooms.mjs';
import { recordKey } from '../../storage.mjs';

export const CANVAS_SCOPE='draw-canvases';
export const CANVAS_QUOTA_ID='quota';
export const NEW_CANVAS_GEOMETRY=Object.freeze({width:1024,height:576});
const LEGACY_CANVAS_GEOMETRY=Object.freeze({width:1024,height:768});
export const CANVAS_LIMITS=Object.freeze({maxStrokes:1500,maxPoints:50000,maxStrokePoints:4096,maxCanvasBytes:2*1024*1024,
  maxBatchPoints:256,maxBodyBytes:32768,maxReceipts:128,maxCanvases:32,maxTotalBytes:16*1024*1024,
  leaseMs:15000,maxQueuedWrites:32,maxQueuedWriteBytes:1024*1024,maxWatchers:128,maxEventsPerWatcher:4,
  maxEventBytes:65536,maxQueuedOutputBytes:2*1024*1024});
const FOREVER=Number.MAX_SAFE_INTEGER,hex32=/^[a-f0-9]{32}$/,hex64=/^[a-f0-9]{64}$/,token=/^[A-Za-z0-9_-]{1,128}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const copy=value=>structuredClone(value),bytes=value=>Buffer.byteLength(JSON.stringify(value));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const canvasIdFor=(roomId,matchId,turnId)=>hash([roomId,matchId,turnId]);
const fail=(status,code,message)=>{throw new RoomError(status,code,message);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
function fields(value,allowed) {if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(400,'INVALID_CANVAS_BODY','画布请求字段无效。');}
function pointCount(value) {return value.strokes.reduce((n,stroke)=>n+stroke.points.length,0);}
function checkedStroke(stroke) {
  fields(stroke,['strokeId','tool','color','width','points']);
  if(typeof stroke.strokeId!=='string'||!token.test(stroke.strokeId)||!['pen','eraser'].includes(stroke.tool)||typeof stroke.color!=='string'||!/^#[a-f0-9]{6}$/i.test(stroke.color)
      ||!Number.isFinite(stroke.width)||stroke.width<1||stroke.width>32||!Array.isArray(stroke.points)||!stroke.points.length
      ||stroke.points.length>CANVAS_LIMITS.maxStrokePoints||stroke.points.some(point=>!Array.isArray(point)||point.length!==2||point.some(n=>!Number.isFinite(n)||n<0||n>1)))
    fail(400,'INVALID_CANVAS_STROKE','笔画坐标或工具无效。');
  return {strokeId:stroke.strokeId,tool:stroke.tool,color:stroke.color.toLowerCase(),width:stroke.width,points:copy(stroke.points)};
}
function reference(value) {return typeof value.roomId==='string'&&hex32.test(value.roomId)&&typeof value.matchId==='string'&&hex32.test(value.matchId)
  &&typeof value.turnId==='string'&&token.test(value.turnId)
  &&value.canvasId===canvasIdFor(value.roomId,value.matchId,value.turnId);}
export function validateCanvasRecord(value) {
  try {
    if(value?.schemaVersion!==1)throw new Error();
    if(value.kind==='quota') {
      fields(value,['schemaVersion','kind','entries','totalBytes']);
      if(!object(value.entries)||Object.keys(value.entries).length>64||!Number.isSafeInteger(value.totalBytes)||value.totalBytes<0)throw new Error();
      let total=0;for(const [canvasId,entry] of Object.entries(value.entries)) {
        fields(entry,['roomId','matchId','turnId','bytes']);
        if(!reference({...entry,canvasId})||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>CANVAS_LIMITS.maxCanvasBytes)throw new Error();total+=entry.bytes;
      }
      if(total!==value.totalBytes)throw new Error();return value;
    }
    fields(value,['schemaVersion','kind','canvasId','roomId','matchId','turnId','geometry','sequence','clearGeneration','leaseGeneration','strokes','undone','requests','updatedAt']);
    if(value.geometry!==undefined) {
      fields(value.geometry,['width','height']);
      if(value.geometry.width!==1024||![576,768].includes(value.geometry.height))throw new Error();
    }
    if(value.kind!=='canvas'||!reference(value)||![value.sequence,value.clearGeneration,value.leaseGeneration].every(n=>Number.isSafeInteger(n)&&n>=0)
        ||!Number.isFinite(value.updatedAt)||!Array.isArray(value.strokes)||!Array.isArray(value.undone)||value.strokes.length+value.undone.length>CANVAS_LIMITS.maxStrokes
        ||!object(value.requests)||Object.keys(value.requests).length>CANVAS_LIMITS.maxReceipts)throw new Error();
    const strokes=[...value.strokes,...value.undone],ids=new Set();let points=0;
    for(const stroke of strokes) {checkedStroke(stroke);if(ids.has(stroke.strokeId))throw new Error();ids.add(stroke.strokeId);points+=stroke.points.length;}
    if(points>CANVAS_LIMITS.maxPoints||bytes(value)>CANVAS_LIMITS.maxCanvasBytes)throw new Error();
    for(const [id,receipt] of Object.entries(value.requests)) {
      fields(receipt,['actorSeatId','fingerprint','ack']);fields(receipt.ack,['canvasId','sequence','clearGeneration','leaseGeneration','persisted']);
      if(!hex64.test(id)||!hex32.test(receipt.actorSeatId??'')||!hex64.test(receipt.fingerprint??'')||receipt.ack.canvasId!==value.canvasId||receipt.ack.persisted!==true
          ||![receipt.ack.sequence,receipt.ack.clearGeneration,receipt.ack.leaseGeneration].every(n=>Number.isSafeInteger(n)&&n>=0)
          ||receipt.ack.sequence>value.sequence||receipt.ack.clearGeneration>value.clearGeneration||receipt.ack.leaseGeneration>value.leaseGeneration)throw new Error();
    }
    return value;
  } catch {throw new Error('Invalid draw canvas record');}
}
export function validateCanvasCollection(values) {
  const canvases=new Map();let quota;
  for(const raw of values) {
    const value=validateCanvasRecord(raw);
    if(value.kind==='quota') {if(quota)throw new Error('Duplicate draw canvas quota');quota=value;}
    else {if(canvases.has(value.canvasId))throw new Error('Duplicate draw canvas');canvases.set(value.canvasId,value);}
  }
  if(!quota||Object.keys(quota.entries).length!==canvases.size)throw new Error('Draw canvas quota references do not match');
  for(const [id,value] of canvases)if(quota.entries[id]?.bytes!==bytes(value))throw new Error('Draw canvas quota bytes do not match');
  return true;
}

export function createCanvasService({storage,rooms,now=Date.now,...overrides}={}) {
  if(!storage?.compareAndSwapMany||!storage?.read||!storage?.scan||!rooms?.getGameContext||typeof now!=='function')throw new TypeError('Canvas requires atomic storage and trusted room context');
  const configurable=['maxCanvases','maxTotalBytes','leaseMs','maxQueuedWrites','maxQueuedWriteBytes','maxWatchers','maxEventsPerWatcher','maxEventBytes','maxQueuedOutputBytes'];
  if(Object.keys(overrides).some(key=>!configurable.includes(key))||Object.values(overrides).some(value=>!Number.isSafeInteger(value)||value<1))throw new TypeError('Invalid canvas limits');
  const limits={...CANVAS_LIMITS,...overrides};
  if(limits.maxCanvases>63||limits.leaseMs>60000||limits.maxEventBytes>CANVAS_LIMITS.maxBodyBytes*2)throw new TypeError('Invalid canvas limits');
  const bootId=randomUUID(),writers=new Map(),listeners=new Set();let closed=false,flight=Promise.resolve(),queuedWrites=0,queuedWriteBytes=0,queuedOutputBytes=0;
  async function ensureQuota() {
    for(let attempt=0;attempt<3;attempt++) {
      const existing=await storage.read(CANVAS_SCOPE,CANVAS_QUOTA_ID);
      if(existing) {
        const records=await storage.scan(CANVAS_SCOPE),current=await storage.read(CANVAS_SCOPE,CANVAS_QUOTA_ID);
        if(current?.version!==existing.version)continue;
        validateCanvasCollection(records.map(record=>record.value));return;
      }
      const records=await storage.scan(CANVAS_SCOPE),entries={},guards=[];
      if(records.some(record=>record.value.kind==='quota'))continue;
      for(const record of records) {
        const value=validateCanvasRecord(record.value);if(value.kind!=='canvas')throw new Error('Invalid draw canvas quota');
        entries[value.canvasId]={roomId:value.roomId,matchId:value.matchId,turnId:value.turnId,bytes:bytes(value)};
        guards.push({scope:CANVAS_SCOPE,id:value.canvasId,expectedVersion:record.version});
      }
      const value={schemaVersion:1,kind:'quota',entries,totalBytes:Object.values(entries).reduce((n,entry)=>n+entry.bytes,0)};
      validateCanvasRecord(value);
      if(await storage.compareAndSwapMany({changes:[{scope:CANVAS_SCOPE,id:CANVAS_QUOTA_ID,expectedVersion:null,value}],guards}))return;
    }
    throw new Error('Canvas quota could not be initialized');
  }
  const ready=ensureQuota();ready.catch(()=>{});
  async function context(code,userKey,write=false) {
    if(closed)fail(503,'CANVAS_CLOSED','画布服务正在重启。');
    try {await ready;}catch {fail(503,'CANVAS_INVALID','已保存的画布容量关系暂时无法验证。');}
    // A canvas needs current membership and transaction guards, never the
    // member's full private game projection or frozen word definitions.
    const ctx=await rooms.getGameContext(code,userKey,{includeView:false});
    if(!hex32.test(ctx.roomId??'')||!hex32.test(ctx.seatId??'')||!['player','spectator'].includes(ctx.role)||!Number.isFinite(ctx.expiresAt)
        ||ctx.roomGuard?.scope!=='rooms'||ctx.roomGuard.id!==ctx.roomId||ctx.roomGuard.expectedVersion!==ctx.roomRecord?.version)
      fail(503,'CANVAS_CONTEXT_INVALID','暂时无法核实画布房间。');
    if(now()>=ctx.expiresAt)fail(404,'ROOM_NOT_FOUND','房间已失效。');
    if(write&&(ctx.role!=='player'||ctx.seatId!==ctx.drawerSeatId))fail(403,'CANVAS_DRAWER_REQUIRED','只有当前画者能操作画布。');
    if(write&&(!hex32.test(ctx.matchId??'')||!token.test(ctx.turnId??'')||ctx.phase!=='drawing'||ctx.roomPhase!=='playing'||ctx.paused
        ||!Number.isFinite(ctx.deadline)||now()>=ctx.deadline))fail(409,'CANVAS_STAGE_CLOSED','当前阶段不能继续画。');
    return ctx;
  }
  function blank(ctx) {return {schemaVersion:1,kind:'canvas',canvasId:canvasIdFor(ctx.roomId,ctx.matchId,ctx.turnId),roomId:ctx.roomId,
    matchId:ctx.matchId,turnId:ctx.turnId,geometry:{...NEW_CANVAS_GEOMETRY},sequence:0,clearGeneration:0,leaseGeneration:0,strokes:[],undone:[],requests:{},updatedAt:now()};}
  async function load(ctx) {
    const id=canvasIdFor(ctx.roomId,ctx.matchId,ctx.turnId),saved=await storage.read(CANVAS_SCOPE,id);
    if(saved) {try{validateCanvasRecord(saved.value);}catch{fail(503,'CANVAS_INVALID','已保存的画布暂时无法读取。');}
      if(saved.value.kind!=='canvas'||saved.value.canvasId!==id)fail(503,'CANVAS_INVALID','已保存的画布暂时无法读取。');return saved;}
    const raw=await storage.adapter?.get?.(recordKey(CANVAS_SCOPE,id));
    if(raw&&raw.expiresAt>now())fail(503,'CANVAS_INVALID','已保存的画布暂时无法读取。');
    return {value:blank(ctx),version:null};
  }
  function projection(ctx,value) {
    return {bootId,canvasId:value.canvasId,roomId:ctx.roomId,matchId:ctx.matchId,turnId:ctx.turnId,stage:ctx.phase,
      deadline:ctx.deadline,paused:ctx.paused,sequence:value.sequence,clearGeneration:value.clearGeneration,leaseGeneration:value.leaseGeneration,
      geometry:copy(value.geometry??LEGACY_CANVAS_GEOMETRY),strokes:copy(value.strokes),pointCount:pointCount(value)};
  }
  async function read(code,userKey) {
    const ctx=await context(code,userKey);
    if(!ctx.matchId||!ctx.turnId)return {bootId,canvasId:null,roomId:ctx.roomId,matchId:null,turnId:null,stage:ctx.phase,deadline:ctx.deadline,paused:ctx.paused,
      geometry:{...NEW_CANVAS_GEOMETRY},sequence:0,clearGeneration:0,leaseGeneration:0,strokes:[],pointCount:0};
    const saved=await load(ctx),current=await context(code,userKey);
    if(current.roomId!==ctx.roomId||current.matchId!==ctx.matchId||current.turnId!==ctx.turnId)fail(409,'CANVAS_TURN_CHANGED','题目已变化，请读取当前画布。');
    return projection(current,saved.value);
  }
  function guards(ctx) {return [{...ctx.roomGuard,validUntil:ctx.expiresAt},...(ctx.presenceGuard?[ctx.presenceGuard]:[]),...(ctx.invitationGuard?[ctx.invitationGuard]:[])];}
  async function commit(ctx,saved,value,validUntil) {
    validateCanvasRecord(value);return commitValidated(ctx,saved,value,validUntil);
  }
  // Only private cloned values which passed a complete validation reach this
  // helper. They are not exposed while the quota read is pending.
  async function commitValidated(ctx,saved,value,validUntil) {
    const quota=await storage.read(CANVAS_SCOPE,CANVAS_QUOTA_ID);if(!quota)fail(503,'CANVAS_QUOTA_UNAVAILABLE','暂时无法核实画布容量。');
    try{validateCanvasRecord(quota.value);}catch{fail(503,'CANVAS_QUOTA_UNAVAILABLE','暂时无法核实画布容量。');}
    const next=copy(quota.value),old=next.entries[value.canvasId],valueBytes=bytes(value);
    next.entries[value.canvasId]={roomId:value.roomId,matchId:value.matchId,turnId:value.turnId,bytes:valueBytes};
    next.totalBytes=next.totalBytes-(old?.bytes??0)+valueBytes;
    if(Object.keys(next.entries).length>limits.maxCanvases||next.totalBytes>limits.maxTotalBytes)fail(429,'CANVAS_CAPACITY','当前画布容量已满，已确认的图仍可读取。');
    return storage.compareAndSwapMany({changes:[{scope:CANVAS_SCOPE,id:value.canvasId,expectedVersion:saved.version,value},
      {scope:CANVAS_SCOPE,id:CANVAS_QUOTA_ID,expectedVersion:quota.version,value:next}],guards:guards(ctx),validUntil:Math.min(validUntil,ctx.expiresAt)});
  }
  function schedule(input,work) {
    const size=bytes(input??{});if(closed)fail(503,'CANVAS_CLOSED','画布服务正在重启。');
    if(size>limits.maxBodyBytes)fail(413,'CANVAS_BATCH_TOO_LARGE','画布批次过大。');
    if(queuedWrites>=limits.maxQueuedWrites||queuedWriteBytes+size>limits.maxQueuedWriteBytes)fail(429,'CANVAS_BUSY','画布正在同步，请先读取确认状态。');
    queuedWrites++;queuedWriteBytes+=size;
    const result=flight.then(work);flight=result.catch(()=>{});
    return result.finally(()=>{queuedWrites--;queuedWriteBytes-=size;});
  }
  function checkedDevice(input,action) {
    fields(input,action==='acquire'?['deviceId','canvasId','bootId']:['deviceId','canvasId','bootId','leaseGeneration','clearGeneration','expectedSequence','requestId',...(action==='append'?['operations']:[])]);
    if(typeof input.deviceId!=='string'||!token.test(input.deviceId)||input.deviceId.length>64)fail(400,'INVALID_CANVAS_DEVICE','画笔设备编号无效。');
    if(typeof input.canvasId!=='string'||!hex64.test(input.canvasId)||typeof input.bootId!=='string'||!uuid.test(input.bootId))
      fail(400,'INVALID_CANVAS_REQUEST','画笔操作需要当前画布与服务实例编号。');
    if(action!=='acquire'&&(typeof input.requestId!=='string'||!token.test(input.requestId)||![input.leaseGeneration,input.clearGeneration,input.expectedSequence].every(n=>Number.isSafeInteger(n)&&n>=0)))
      fail(400,'INVALID_CANVAS_REQUEST','画布代际或请求编号无效。');
  }
  function ack(value,lease) {return {bootId,canvasId:value.canvasId,sequence:value.sequence,clearGeneration:value.clearGeneration,leaseGeneration:value.leaseGeneration,
    leaseValidUntil:lease.validUntil,persisted:true};}
  async function acquire(code,userKey,input,trusted={}) {
    checkedDevice(input,'acquire');return schedule(input,async()=>{
      const ctx=await context(code,userKey,true);
      if(input.canvasId!==canvasIdFor(ctx.roomId,ctx.matchId,ctx.turnId))fail(409,'CANVAS_TURN_CHANGED','题目已变化，请重新确认当前题拿笔。');
      if(input.bootId!==bootId)fail(409,'CANVAS_STALE_WRITER','画布服务已重启，请先读取并确认接管。');
      const saved=await load(ctx),value=copy(saved.value);
      if(value.leaseGeneration>=Number.MAX_SAFE_INTEGER)fail(503,'CANVAS_SEQUENCE_LIMIT','当前画布已到序号上限。');
      value.leaseGeneration++;value.updatedAt=now();
      if(!await commit(ctx,saved,value,ctx.deadline))fail(409,'CANVAS_CONFLICT','房间或画布已变化，请先读取确认状态。');
      const lease={bootId,userKey,actorSeatId:ctx.seatId,deviceId:input.deviceId,generation:value.leaseGeneration,
        authorizationId:trusted.authorizationId??null,validUntil:Math.min(now()+limits.leaseMs,ctx.deadline,ctx.expiresAt)};
      writers.set(value.canvasId,lease);await publish(ctx.roomId,{kind:'replace',...projection(ctx,value)});
      return {...ack(value,lease),validUntil:lease.validUntil};
    });
  }
  async function mutate(action,code,userKey,input,trusted={}) {
    checkedDevice(input,action);
    if(action==='append'&&!Array.isArray(input.operations))fail(400,'INVALID_CANVAS_BODY','画布批次需要笔画数组。');
    if(action==='append'&&(!input.operations.length||input.operations.length>16
        ||input.operations.reduce((n,op)=>n+(Array.isArray(op?.points)?op.points.length:0),0)>limits.maxBatchPoints))
      fail(413,'CANVAS_BATCH_TOO_LARGE','每批最多16笔和256点。');
    const operations=action==='append'?input.operations.map(checkedStroke):null;
    return schedule(input,async()=>{
      const ctx=await context(code,userKey,true);
      if(input.canvasId!==canvasIdFor(ctx.roomId,ctx.matchId,ctx.turnId))fail(409,'CANVAS_TURN_CHANGED','题目已变化，旧笔迹不能写入新题。');
      if(input.bootId!==bootId)fail(409,'CANVAS_STALE_WRITER','画布服务已重启，请先读取并确认接管。');
      const saved=await load(ctx),lease=writers.get(saved.value.canvasId),value=copy(saved.value);
      if(!lease||lease.bootId!==bootId||lease.userKey!==userKey||lease.actorSeatId!==ctx.seatId||lease.deviceId!==input.deviceId
          ||lease.authorizationId!==(trusted.authorizationId??null)||lease.generation!==input.leaseGeneration||lease.generation!==value.leaseGeneration||now()>=lease.validUntil)
        fail(409,'CANVAS_STALE_WRITER','画笔授权已过期或由其他设备接管，请先确认接管。');
      const id=hash([ctx.seatId,input.requestId]),fingerprint=hash([action,input.canvasId,input.bootId,input.deviceId,input.leaseGeneration,input.clearGeneration,input.expectedSequence,operations]),previous=value.requests[id];
      if(previous) {
        if(previous.fingerprint!==fingerprint)fail(409,'CANVAS_REQUEST_REUSED','同一请求编号不能改成另一批笔迹。');
        return {ack:{...previous.ack,bootId,leaseValidUntil:lease.validUntil},duplicate:true};
      }
      if(input.clearGeneration!==value.clearGeneration)fail(409,'CANVAS_STALE_CLEAR','画布已清空，请读取新画布。');
      if(input.expectedSequence!==value.sequence)fail(409,'CANVAS_SEQUENCE_GAP','画布序号不连续，请先读取确认状态。');
      if(value.sequence>=Number.MAX_SAFE_INTEGER||value.clearGeneration>=Number.MAX_SAFE_INTEGER)fail(503,'CANVAS_SEQUENCE_LIMIT','当前画布已到序号上限。');
      value.sequence++;value.updatedAt=now();
      if(action==='append') {
        value.undone=[];
        for(const operation of operations) {
          const old=value.strokes.find(stroke=>stroke.strokeId===operation.strokeId);
          if(old) {if(old.tool!==operation.tool||old.color!==operation.color||old.width!==operation.width)fail(409,'CANVAS_STROKE_CHANGED','同一笔的工具不能中途改变。');old.points.push(...operation.points);}
          else value.strokes.push(copy(operation));
        }
      } else if(action==='clear') {value.strokes=[];value.undone=[];value.clearGeneration++;}
      else if(action==='undo'&&value.strokes.length)value.undone.push(value.strokes.pop());
      else if(action==='redo'&&value.undone.length)value.strokes.push(value.undone.pop());
      const metadata={canvasId:value.canvasId,sequence:value.sequence,clearGeneration:value.clearGeneration,leaseGeneration:value.leaseGeneration,persisted:true};
      value.requests[id]={actorSeatId:ctx.seatId,fingerprint,ack:metadata};
      while(Object.keys(value.requests).length>limits.maxReceipts)delete value.requests[Object.keys(value.requests)[0]];
      try {validateCanvasRecord(value);} catch {fail(413,'CANVAS_LIMIT','当前图已到笔画、点数或字节上限，已确认的图仍可猜。');}
      if(!await commitValidated(ctx,saved,value,Math.min(ctx.deadline,lease.validUntil)))fail(409,'CANVAS_CONFLICT','房间或画布已变化，请先读取确认状态。');
      lease.validUntil=Math.min(now()+limits.leaseMs,ctx.deadline,ctx.expiresAt);
      const packet=action==='append'?{kind:'append',bootId,canvasId:value.canvasId,roomId:ctx.roomId,matchId:ctx.matchId,turnId:ctx.turnId,
        sequence:value.sequence,clearGeneration:value.clearGeneration,leaseGeneration:value.leaseGeneration,operations,pointCount:pointCount(value)}:{kind:'replace',...projection(ctx,value)};
      await publish(ctx.roomId,packet);return {ack:ack(value,lease),duplicate:false};
    });
  }
  function end(listener,error) {if(!listener.active)return;listener.active=false;listeners.delete(listener);try{listener.onEnd?.(error.message,error.status??503);}catch{}}
  function eventSize(packet) {return bytes(packet);}
  async function deliver(listener,packet) {
    if(!listener.active)return;
    if(eventSize(packet)>limits.maxEventBytes)packet={kind:'recovery',bootId,canvasId:packet.canvasId,roomId:packet.roomId,matchId:packet.matchId,turnId:packet.turnId,
      sequence:packet.sequence,clearGeneration:packet.clearGeneration,leaseGeneration:packet.leaseGeneration,requiresRead:true};
    const queuedBytes=eventSize(packet);
    if(++listener.queued>limits.maxEventsPerWatcher||queuedOutputBytes+queuedBytes>limits.maxQueuedOutputBytes) {listener.queued--;end(listener,new RoomError(503,'CANVAS_BACKPRESSURE','画布同步落后，请只读恢复。'));return;}
    queuedOutputBytes+=queuedBytes;
    listener.flight=listener.flight.then(async()=>{
      if(!listener.active)return;
      const ctx=await context(listener.code,listener.userKey);
      if(ctx.roomId!==packet.roomId||ctx.matchId!==packet.matchId||ctx.turnId!==packet.turnId)return;
      await listener.onEvent(copy(packet));
    }).catch(error=>end(listener,error)).finally(()=>{listener.queued--;queuedOutputBytes-=queuedBytes;});
    return listener.flight;
  }
  async function publish(roomId,packet) {await Promise.all([...listeners].filter(listener=>listener.roomId===roomId).map(listener=>deliver(listener,packet)));}
  async function watch(code,userKey,onEvent,onEnd) {
    if(typeof onEvent!=='function')throw new TypeError('Canvas watcher requires callback');
    // Serialize initial snapshot + subscription with this instance's writes so
    // a batch cannot commit between reading the snapshot and joining delivery.
    return schedule({},async()=>{
      const snapshot=await read(code,userKey);if(listeners.size>=limits.maxWatchers)fail(429,'CANVAS_STREAM_LIMIT','画布连接数已到上限。');
      const listener={code,userKey,roomId:snapshot.roomId,onEvent,onEnd,active:true,queued:0,flight:Promise.resolve()};listeners.add(listener);
      await deliver(listener,{kind:'snapshot',...snapshot});return ()=>{listener.active=false;listeners.delete(listener);};
    });
  }
  function invalidateActor(userKey) {for(const [id,lease] of writers)if(lease.userKey===userKey)writers.delete(id);}
  function invalidateAuthorization(authorizationId) {for(const [id,lease] of writers)if(lease.authorizationId===authorizationId)writers.delete(id);}
  async function sweep() {
    if(closed)return;await ready;
    for(const [id,lease] of writers)if(now()>=lease.validUntil)writers.delete(id);
    for(const saved of await storage.scan(CANVAS_SCOPE)) {
      const value=validateCanvasRecord(saved.value);if(value.kind!=='canvas')continue;
      const room=await storage.read('rooms',value.roomId),snapshot=room?.value.snapshot,game=snapshot?.game;
      const same=snapshot&&snapshot.matchId===value.matchId&&game?.turnId===value.turnId;
      // The room owner computes lifecycle expiry and removes expired snapshots
      // in rooms.sweep(). Never reconstruct or renew its TTL in this module.
      if(same)continue;
      const quota=await storage.read(CANVAS_SCOPE,CANVAS_QUOTA_ID);if(!quota)continue;const next=copy(validateCanvasRecord(quota.value)),entry=next.entries[value.canvasId];
      if(entry){delete next.entries[value.canvasId];next.totalBytes-=entry.bytes;}
      if(await storage.compareAndSwapMany({changes:[{scope:CANVAS_SCOPE,id:value.canvasId,expectedVersion:saved.version,value:null},
        {scope:CANVAS_SCOPE,id:CANVAS_QUOTA_ID,expectedVersion:quota.version,value:next}],guards:[{scope:'rooms',id:value.roomId,expectedVersion:room?.version??null}]}))writers.delete(value.canvasId);
    }
  }
  async function close() {closed=true;const closing=[...listeners];for(const listener of closing)end(listener,new RoomError(503,'CANVAS_CLOSED','画布服务正在重启。'));writers.clear();await ready.catch(()=>{});await flight;
    await Promise.allSettled(closing.map(listener=>listener.flight));}
  return {read,acquire,append:(...args)=>mutate('append',...args),undo:(...args)=>mutate('undo',...args),redo:(...args)=>mutate('redo',...args),clear:(...args)=>mutate('clear',...args),
    watch,close,sweep,invalidateActor,invalidateAuthorization,bootId,limits,ready};
}
