import { RoomError } from '../app/rooms.mjs';
import { createDeck,evaluateDraft } from '../app/rules.mjs';

const failure=(status,code,message)=>new RoomError(status,code,message);
const fence=view=>JSON.stringify([view.roomId,view.matchId,view.phase,view.game?.revision,view.game?.turnPlayerId]);
const supported=view=>view.gameType==='rummikub' && ['friends-v1','friends-v2','friends-v3','friends-v4'].includes(view.game?.ruleVersion);
const tile=({id,color,value,joker,jokerType})=>({id,color,value,...(joker?{joker:true,...(jokerType?{jokerType}:{})}:{})});
function validatePublicDraft(game,board) {
  const options={copies:game.copies ?? 2,jokerCount:game.jokerCount ?? 2,...(game.jokerConfig?{jokerConfig:game.jokerConfig}:{}),ruleVersion:game.ruleVersion};
  const known=new Set([...game.board.flat(),...game.rack].map(card=>card.id));
  // This is a canonical validation-only remainder, NOT an actual draw pile or
  // another player's rack. It is never stored or exposed in the public packet.
  const pool=createDeck(options).filter(card=>!known.has(card.id)),placed=new Set(board.flat().map(card=>card.id));
  const committed={version:1,ruleVersion:game.ruleVersion,...(game.jokerConfig===undefined?{}:{jokerConfig:structuredClone(game.jokerConfig)}),board:game.board,rack:game.rack,pool,opened:game.opened,round:game.round ?? 1};
  const draft={...committed,board,rack:game.rack.filter(card=>!placed.has(card.id))};
  return evaluateDraft(committed,draft,options);
}

/** Short-lived, public-only arrangement. Nothing here is written to storage. */
export function createRoomPreview({now=Date.now,ttlMs=30000,checksPerSecond=1.8,minIntervalMs=1000,maxChannels=100,sweepMs=1000}={}) {
  const channels=new Map();let globalNext=0,closed=false;
  function channel(code) {
    let entry=channels.get(code);
    if(!entry) {
      if(channels.size>=maxChannels) throw failure(503,'PREVIEW_CAPACITY','桌面整理预览暂时繁忙。');
      entry={code,view:null,fence:null,active:null,sources:new Map(),listeners:new Set(),nextAllowedAt:0,clearReason:'empty'};
      channels.set(code,entry);
    }
    return entry;
  }
  const watchers=entry=>[...entry.listeners].filter(listener=>listener.playerId!==entry.view?.game?.turnPlayerId).length;
  const interval=entry=>Math.max(minIntervalMs,Math.ceil((2+watchers(entry))/checksPerSecond*1000));
  function notify(entry,{budgeted=false}={}) {
    const recipients=[...entry.listeners].filter(listener=>listener.playerId!==entry.view?.game?.turnPlayerId);
    // Lifecycle clears also count against the conservative next publication
    // budget. A necessary clear may happen immediately, then delays previews.
    if(!budgeted) globalNext=Math.max(now(),globalNext)+Math.ceil(recipients.length/checksPerSecond*1000);
    for(const listener of recipients) listener.send();
  }
  function clear(entry,reason,emit=true) {
    if(entry.active) {entry.sources.get(entry.active.previewId).retired=true;entry.active=null;entry.clearReason=reason;if(emit) notify(entry);}
  }
  function observe(view) {
    const entry=channel(view.roomCode),next=fence(view);
    if(entry.view?.roomId===view.roomId && Number.isSafeInteger(view.revision) && view.revision<entry.view.roomRevision) return entry;
    if(entry.fence!==next) {
      clear(entry,'turn-changed',false);entry.sources.clear();entry.fence=next;
    }
    // Only public metadata, never the observer's rack, is retained.
    entry.view={roomId:view.roomId,roomCode:view.roomCode,matchId:view.matchId,phase:view.phase,gameType:view.gameType,
      roomRevision:view.revision ?? 0,
      expiresAt:Number.isFinite(view.expiresAt)?view.expiresAt:entry.view?.expiresAt ?? now()+8*3600000,
      game:view.game?{revision:view.game.revision,turnPlayerId:view.game.turnPlayerId,ruleVersion:view.game.ruleVersion}:null};
    if(entry.active && now()>=entry.active.expiresAt) clear(entry,'expired');
    return entry;
  }
  function throttle(entry,cost) {
    const time=now(),deadline=Math.max(globalNext,entry?.nextAllowedAt || 0);
    if(time<deadline) {
      const error=failure(429,'PREVIEW_RATE_LIMIT','桌面整理预览正在合并更新，请稍等。');
      Object.assign(error,{minIntervalMs:entry?interval(entry):Math.ceil(cost/checksPerSecond*1000),nextAllowedAt:deadline,retryAfter:Math.max(1,Math.ceil((deadline-time)/1000))});
      throw error;
    }
    globalNext=time+Math.ceil(cost/checksPerSecond*1000);
    if(entry) entry.nextAllowedAt=time+interval(entry);
    return {at:time,cost};
  }
  // Reserve before online identity calls. A rate rejection cannot consume an
  // unbounded number of shared identity checks. It grants no authentication.
  function reserve(code,{read=false}={}) {
    if(closed) throw failure(503,'PREVIEW_CLOSED','桌面预览已关闭。');
    const entry=channels.get(code);
    return throttle(read?null:entry,2+(read?0:entry?watchers(entry):0));
  }
  function prepare(view,body,sessionId) {
    if(!supported(view)) throw failure(400,'PREVIEW_UNSUPPORTED','本游戏没有桌面整理预览。');
    if(view.phase!=='playing' || view.game.status!=='playing' || view.selfId!==view.game.turnPlayerId) throw failure(409,'PREVIEW_NOT_TURN','只有正在出牌的玩家可以整理桌面。');
    const fields=body.clear===true?['previewId','sequence','matchId','gameRevision','clear']:['previewId','sequence','matchId','gameRevision','boardIds','positions'];
    if(Object.keys(body).some(field=>!fields.includes(field)) || !/^[A-Za-z0-9_-]{16,128}$/.test(body.previewId || '')
      || !Number.isSafeInteger(body.sequence) || body.sequence<1 || body.matchId!==view.matchId || body.gameRevision!==view.game.revision) throw failure(409,'PREVIEW_STALE','整理预览已过期，请读取当前牌局。');
    const entry=observe(view),source=entry.sources.get(body.previewId);
    if(source && (source.sessionId!==sessionId || source.ownerId!==view.selfId || source.retired || body.sequence<=source.sequence)) throw failure(409,'PREVIEW_SEQUENCE','整理来源或顺序已失效。');
    if(entry.active && entry.active.previewId!==body.previewId) throw failure(409,'PREVIEW_SOURCE_BUSY','另一台设备正在整理本回合桌面。');
    if(!source && entry.sources.size>=64) throw failure(409,'PREVIEW_SOURCE_LIMIT','本回合整理来源过多，请确认或还原牌面后结束回合。');
    if(body.clear===true) {
      if(!source || entry.active?.previewId!==body.previewId) throw failure(409,'PREVIEW_SEQUENCE','没有可以清除的整理预览。');
      return {entry,fence:fence(view),body:structuredClone(body),sessionId,ownerId:view.selfId,preview:null,
        connected:[...entry.listeners].some(listener=>listener.sessionId===sessionId)};
    }
    if(!Array.isArray(body.boardIds) || body.boardIds.length>180 || body.boardIds.some(group=>!Array.isArray(group) || !group.length || group.length>180)
      || body.boardIds.flat().length>180 || JSON.stringify(body).length>24576) throw failure(400,'PREVIEW_INVALID_BOARD','整理桌面过大或格式无效。');
    const positions=body.positions ?? [];
    if(!Array.isArray(positions) || body.positions!==undefined && positions.length!==body.boardIds.length || positions.some(point=>!point || typeof point!=='object' || Array.isArray(point)
      || Object.keys(point).some(field=>!['x','y'].includes(field)) || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x<0 || point.x>1 || point.y<0 || point.y>1)) throw failure(400,'PREVIEW_INVALID_POSITION','整理位置无效。');
    const available=new Map([...view.game.board.flat(),...view.game.rack].map(card=>[card.id,card])),seen=new Set();
    const board=body.boardIds.map(group=>group.map(id=>{
      if(typeof id!=='string' || !available.has(id) || seen.has(id)) throw failure(400,'PREVIEW_PRIVATE_TILE','整理预览只能使用原桌面和自己已经摆出的牌。');
      seen.add(id);return tile(available.get(id));
    }));
    if(view.game.board.flat().some(card=>!seen.has(card.id))) throw failure(400,'PREVIEW_PUBLIC_TILE_MISSING','整理时不能丢失原桌面牌。');
    const validation=validatePublicDraft(view.game,board),validationMessage=validation.valid?'':validation.reason;
    return {entry,fence:fence(view),body:structuredClone(body),sessionId,ownerId:view.selfId,
      connected:[...entry.listeners].some(listener=>listener.sessionId===sessionId),
      ownerName:view.players.find(player=>player.id===view.selfId)?.name || '',preview:{board,positions:structuredClone(positions),valid:validation.valid,validationMessage}};
  }
  function commit(prepared,liveView,permit) {
    if(!supported(liveView) || fence(liveView)!==prepared.fence || liveView.selfId!==prepared.ownerId || liveView.phase!=='playing') throw failure(409,'PREVIEW_STALE','回合或席位已更新，整理预览已丢弃。');
    const entry=observe(liveView),source=entry.sources.get(prepared.body.previewId);
    if(prepared.connected && ![...entry.listeners].some(listener=>listener.sessionId===prepared.sessionId)) throw failure(409,'PREVIEW_DISCONNECTED','整理设备已断开，预览已丢弃。');
    if(source && (source.sessionId!==prepared.sessionId || source.ownerId!==prepared.ownerId || source.retired || prepared.body.sequence<=source.sequence)
      || entry.active && entry.active.previewId!==prepared.body.previewId) throw failure(409,'PREVIEW_SEQUENCE','整理来源或顺序已失效。');
    const time=now(),count=watchers(entry);
    // Subscribers can join during E3. Extend the reserved global budget for the
    // additional actual connections before publishing the safe packet.
    globalNext+=Math.max(0,2+count-(permit?.cost ?? 0))/checksPerSecond*1000;
    entry.nextAllowedAt=Math.max(entry.nextAllowedAt,time+interval(entry));
    entry.sources.set(prepared.body.previewId,{ownerId:prepared.ownerId,sessionId:prepared.sessionId,sequence:prepared.body.sequence,retired:!prepared.preview});
    if(prepared.preview) entry.active={previewId:prepared.body.previewId,sequence:prepared.body.sequence,ownerId:prepared.ownerId,ownerName:prepared.ownerName,
      sessionId:prepared.sessionId,updatedAt:time,expiresAt:time+ttlMs,preview:prepared.preview};
    else {entry.active=null;entry.clearReason='cleared';}
    notify(entry,{budgeted:true});
    return {accepted:true,previewId:prepared.body.previewId,sequence:prepared.body.sequence,observerCount:count,minIntervalMs:interval(entry),nextAllowedAt:Math.max(globalNext,entry.nextAllowedAt)};
  }
  function packet(view,{forStream=false}={}) {
    const entry=observe(view),active=entry.fence===fence(view)?entry.active:null;
    return {version:1,roomId:view.roomId,roomCode:view.roomCode,matchId:view.matchId,gameRevision:view.game?.revision ?? null,turnPlayerId:view.game?.turnPlayerId ?? null,
      ownerId:active?.ownerId ?? null,ownerName:active?.ownerName ?? '',previewId:active?.previewId ?? null,sequence:active?.sequence ?? 0,
      updatedAt:active?.updatedAt ?? null,expiresAt:active?.expiresAt ?? null,observerCount:watchers(entry),minIntervalMs:interval(entry),
      preview:active && (!forStream || active.ownerId!==view.selfId)?structuredClone(active.preview):null,...(!active?{clearReason:entry.clearReason}:{})};
  }
  function subscribe(view,sessionId,send) {
    if(view.gameType!=='rummikub') return ()=>{};
    const entry=observe(view),listener={playerId:view.selfId,sessionId,send};entry.listeners.add(listener);
    return ()=>{entry.listeners.delete(listener);if(entry.active?.sessionId===sessionId && ![...entry.listeners].some(other=>other.sessionId===sessionId)) clear(entry,'disconnected');};
  }
  function clearSession(sessionId) {for(const entry of channels.values()) if(entry.active?.sessionId===sessionId) clear(entry,'identity-failed');}
  function sweep() {
    for(const [code,entry] of channels) {
      if(entry.active && now()>=entry.active.expiresAt) clear(entry,'expired');
      // Retired source IDs survive until this room expires or changes turn.
      // Dropping tombstones after the preview TTL would revive delayed writes.
      if(!entry.listeners.size && !entry.active && now()>=entry.view?.expiresAt) channels.delete(code);
    }
  }
  const timer=sweepMs>0?setInterval(sweep,sweepMs):null;timer?.unref();
  return {reserve,prepare,commit,packet,observe,subscribe,clearSession,sweep,forgetRoom(code){const entry=channels.get(code);if(entry) {clear(entry,'room-closed',false);channels.delete(code);}},close(){closed=true;clearInterval(timer);channels.clear();}};
}
