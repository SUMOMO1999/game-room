import { createHash, randomBytes, randomInt } from 'node:crypto';
import { defaultGameRegistry } from './game-registry.mjs';
import { snapshotHasRoles, snapshotGameType, snapshotFormatProblem, serializeRoomSnapshot } from '../server/room-snapshot-compat.mjs';

const COMMON_ACTIONS = new Set(['ready', 'start', 'rematch', 'leave', 'transferHost', 'pause', 'resume', 'set-role','configure']);
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
export const ROOM_CAPACITY = 7;
export const SPECTATOR_CAPACITY = 8;
const members=room=>[...room.players,...(room.spectators ?? [])];

export class RoomError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) { throw new RoomError(status, code, message); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function validateName(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_NAME', '请填写你的称呼。');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 16 || /\p{Cc}/u.test(name)) {
    fail(400, 'INVALID_NAME', '称呼需要1～16个字，不能包含控制字符。');
  }
  return name;
}
function validateAction(action, adapter) {
  if (!action || typeof action !== 'object' || Array.isArray(action)
      || !COMMON_ACTIONS.has(action.type) && adapter.actionFields(action.type) === null) {
    fail(400, 'INVALID_ACTION', '操作格式无效。');
  }
  if (typeof action.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(action.requestId)) {
    fail(400, 'INVALID_REQUEST_ID', '操作需要有效的请求编号。');
  }
  if (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 0) {
    fail(400, 'INVALID_REVISION', '操作需要当前房间版本。');
  }
  const allowed = new Set(['type', 'requestId', 'expectedRevision']);
  if (action.type === 'ready') {
    allowed.add('ready');
    if (typeof action.ready !== 'boolean') fail(400, 'INVALID_READY', '请选择准备或取消准备。');
  }
  if(action.type==='set-role') {allowed.add('role');if(!['player','spectator'].includes(action.role)) fail(400,'INVALID_ROLE','请选择玩家或观众。');}
  if(action.type==='configure') for (const field of adapter.configurationFields) allowed.add(field);
  for (const field of adapter.actionFields(action.type) ?? []) allowed.add(field);
  if (action.type === 'transferHost') {
    allowed.add('playerId');
    if (action.playerId !== undefined && (typeof action.playerId !== 'string' || !/^[a-f0-9]{32}$/.test(action.playerId))) fail(400, 'INVALID_PLAYER', '请选择房间里的玩家。');
  }
  if (action.type === 'pause') {
    allowed.add('agree');
    if (action.agree !== undefined && typeof action.agree !== 'boolean') fail(400, 'INVALID_VOTE', '请选择同意或取消暂停。');
  }
  if (Object.keys(action).some((key) => !allowed.has(key))) {
    fail(400, 'INVALID_ACTION', '该操作包含不适用的字段。');
  }
  const problem = adapter.validateAction(action);
  if (problem) fail(problem.status, problem.code, problem.message);
}

/** In-memory seats and private projections. Credentials never occur in room views. */
export function createRoomStore({ now = Date.now, ttlMs = 8 * 60 * 60 * 1000,
  pausedTtlMs = 7 * 24 * 60 * 60 * 1000, leaveRetentionMs = 24 * 60 * 60 * 1000,
  hostTakeoverGraceMs = 70000, maxRooms = 100, gameEngine, gameOptions = {}, turnTimeoutMs = 0, gameRegistry = defaultGameRegistry } = {}) {
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 0 || turnTimeoutMs > 24 * 60 * 60 * 1000) throw new TypeError('Invalid turn timeout.');
  const rooms = new Map();
  const closedRooms = new Map();
  const expiry = (room) => room.lastActiveAt + (room.phase === 'paused' ? pausedTtlMs : ttlMs);
  const adapterFor = (room) => gameRegistry.gameAdapter(room.gameType, { gameEngine });
  const activityTypes = new Set([...COMMON_ACTIONS, ...gameRegistry.activityTypes(), 'finished', 'timeout']);
  const currentPlayer = (room) => room.game?.players[room.game.turnIndex]?.id;
  function startClock(room, firstPlayerId = currentPlayer(room), durationMs = turnTimeoutMs) {
    const at = now();
    room.turnClock = { version: 1, durationMs, remainingMs: durationMs, startedAt: at, deadlineAt: at + durationMs,
      pausedAt: null, firstPlayerId, matchId: room.matchId, round: room.game.round, playerId: currentPlayer(room) };
  }
  function syncClock(room) {
    const clock = room.turnClock;
    if (!clock) return;
    if (!['playing', 'paused'].includes(room.phase)) { room.turnClock = null; return; }
    if (room.game.round !== clock.round || currentPlayer(room) !== clock.playerId) {
      startClock(room, clock.firstPlayerId, clock.durationMs);
    } else if (room.phase === 'paused' && clock.pausedAt === null) {
      const at = now(); clock.remainingMs = Math.max(0, clock.deadlineAt - at); clock.pausedAt = at; clock.deadlineAt = null;
    } else if (room.phase === 'playing' && clock.pausedAt !== null) {
      const at = now(); clock.startedAt = at; clock.deadlineAt = at + clock.remainingMs; clock.pausedAt = null;
    }
  }
  function roomType(value) {
    try { return gameRegistry.normalizeGameType(value); }
    catch { fail(400, 'INVALID_GAME_TYPE', '请选择支持的游戏。'); }
  }
  function activity(room, actor, type, text) {
    room.activitySequence = (room.activitySequence ?? 0) + 1;
    room.activity ??= [];
    room.activity.push({ sequence: room.activitySequence, id: `${room.code}:${room.activitySequence}`, at: now(),
      actorName: actor?.name ?? '房间', type, text });
    room.activity = room.activity.slice(-40);
  }
  function localContext(room) {
    const connected = Object.fromEntries(members(room).map((player) => [player.id, !!room.listeners.get(player.id)?.size]));
    return { connected, hostCanTakeOver: !connected[room.hostId]
      && now() >= Math.max(room.hostSinceAt ?? room.lastActiveAt, room.lastSeen?.[room.hostId] ?? 0) + hostTakeoverGraceMs };
  }
  function ensureMatch(room) {
    if (!room.game || room.matchId) return;
    room.matchId = digest(canonical({ roomId: room.roomId ?? room.code, game: room.game })).slice(0, 32);
    room.matchStartedAt = null;
    room.matchParticipants = room.game.players.map(({ id, name }) => ({ playerId: id, name,
      ...(room.players.find((player) => player.id === id)?.userKey ? { userKey: room.players.find((player) => player.id === id).userKey } : {}) }));
  }
  function conclude(room, status, reason) {
    ensureMatch(room);
    if (!room.matchId || room.matchEndedAt !== undefined) return;
    room.matchEndedAt = now();
    const result = status === 'completed' ? room.game.result : null;
    const adapter = adapterFor(room);
    const summary = { matchId: room.matchId, roomId: room.roomId ?? digest(room.code).slice(0, 32), roomCode: room.code,
      game: room.gameType, ruleVersion: room.game.ruleVersion, startedAt: room.matchStartedAt, endedAt: room.matchEndedAt,
      status, reason, ...(room.matchStartedAt === null ? { legacy: true } : {}),
      players: (room.matchParticipants ?? []).filter((player) => player.userKey).map((player) => ({
        userKey: player.userKey, seatId: player.playerId, nickname: player.name,
        ...adapter.playerResult(result, player.playerId),
      })) };
    room.pendingRecords ??= [];
    // Older anonymous or mixed-seat games have no complete account ownership; never invent history participants.
    if (summary.players.length === room.game.players.length && summary.players.length >= 2
        && !room.pendingRecords.some((record) => record.matchId === summary.matchId)) room.pendingRecords.push(summary);
  }
  function abort(room, reason = 'player-left') {
    if (!['playing', 'paused'].includes(room.phase)) return;
    conclude(room, 'aborted', reason);
    room.phase = 'aborted'; room.pauseVote = null;
    if (Object.hasOwn(room, 'turnClock')) room.turnClock = null;
    room.abortedResult = { reason, winnerIds: [], scores: [], tie: false, aborted: true };
  }
  function finishListeners(room, reason) {
    const listeners = [...room.listeners.values()].flatMap((set) => [...set]);
    room.listeners.clear();
    for (const listener of listeners) {
      try { listener.onEnd?.(reason); } catch { /* The connection is already closed. */ }
    }
  }
  function sweep() {
    for (const [code, room] of closedRooms) if (now() >= room.closedAt + leaveRetentionMs) closedRooms.delete(code);
    for (const [code, room] of rooms) {
      if (now() >= expiry(room)) {
        abort(room, 'expired');
        rooms.delete(code);
        finishListeners(room, '房间长时间没有活动，已回收。');
      }
    }
  }
  function getRoom(code) {
    sweep();
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
    const room = rooms.get(code);
    if (!room) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
    return room;
  }
  function authenticate(room, token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      fail(401, 'INVALID_TOKEN', '席位凭证无效，请重新加入房间。');
    }
    const tokenHash = digest(token);
    const player = members(room).find((candidate) => candidate.tokenHash === tokenHash);
    if (!player) fail(401, 'INVALID_TOKEN', '席位凭证无效，请重新加入房间。');
    return player;
  }
  function playerView(room, player, context = localContext(room)) {
    const selfRole=room.players.some(candidate=>candidate.id===player.id)?'player':'spectator';
    const game = room.game ? structuredClone(selfRole==='player'?adapterFor(room).privateView(room.game, player.id):adapterFor(room).spectatorView(room.game)) : null;
    if (game && room.phase === 'aborted') { game.status = 'aborted'; game.result = structuredClone(room.abortedResult); game.winnerId = null; }
    if (game && room.phase === 'paused') game.status = 'paused';
    return {
      roomCode: room.code, phase: room.phase, revision: room.revision,
      ...gameRegistry.gameInfo(room.gameType),
      ...(room.roomId ? { roomId: room.roomId } : {}),
      hostId: room.hostId, selfId: player.id,
      selfRole,spectatorCapacity:SPECTATOR_CAPACITY,
      ...adapterFor(room).roomView(room),
      hostCanTakeOver: selfRole==='player' && !!context.hostCanTakeOver, expiresAt: expiry(room),
      matchId: room.matchId ?? null,
      ...(Object.hasOwn(room, 'turnClock') ? { turnClock: structuredClone(room.turnClock), serverTime: now() } : {}),
      activity: structuredClone(room.activity ?? []),
      pause: room.pauseVote ? { type: 'pause', requestedBy: room.pauseVote.requestedBy,
        agreedIds: [...room.pauseVote.agreedIds], requiredIds: room.players.map((candidate) => candidate.id) } : null,
      players: room.players.map((candidate) => {
        return {
          id: candidate.id, name: candidate.name, ready: candidate.ready,
          connected: !!context.connected[candidate.id],
          ...adapterFor(room).playerSummary(game, candidate.id),
        };
      }),
      spectators:(room.spectators ?? []).map(candidate=>({id:candidate.id,name:candidate.name,connected:!!context.connected[candidate.id]})),
      game,
    };
  }
  function broadcast(room) {
    for (const player of members(room)) {
      for (const listener of room.listeners.get(player.id) ?? []) {
        try { listener.onView(playerView(room, player)); } catch { /* Isolated failed subscriber. */ }
      }
    }
  }
  function makePlayer(name, userKey) {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      player: { id: randomBytes(16).toString('hex'), name: validateName(name),
        ...(userKey ? { userKey } : { tokenHash: digest(token) }), ready: false, requests: new Map() },
    };
  }
  function credentials(room, player, token) {
    return { roomCode: room.code, playerId: player.id, token, view: playerView(room, player) };
  }
  function createRoom(name, { gameType = 'rummikub' } = {}) {
    gameType = roomType(gameType);
    sweep();
    if (rooms.size >= maxRooms) fail(503, 'ROOM_LIMIT', '本机房间已满，请稍后再试。');
    const { player, token } = makePlayer(name);
    let code;
    do { code = String(randomInt(1_000_000)).padStart(6, '0'); } while (rooms.has(code) || closedRooms.has(code));
    const room = { code, gameType, hostId: player.id, phase: 'waiting', revision: 0,
      players: [player], game: null, listeners: new Map(), lastActiveAt: now(), hostSinceAt: now(), leaveReceipts: {}, pendingRecords: [] };
    rooms.set(code, room);
    return credentials(room, player, token);
  }
  function joinRoom(code, name, {role}={}) {
    const room = getRoom(code);
    const joiningRole=joinRole(room,role);
    const { player, token } = makePlayer(name);
    if(joiningRole==='player') room.players.push(player);else {room.rolesEnabled=true;room.spectators ??= [];room.spectators.push(player);}
    room.revision += 1;
    room.lastActiveAt = now();
    broadcast(room);
    return credentials(room, player, token);
  }
  function getView(code, token) {
    const room = getRoom(code);
    const player = authenticate(room, token);
    return playerView(room, player);
  }
  function act(room, player, input, context = localContext(room)) {
    const code = room.code;
    const adapter = adapterFor(room);
    validateAction(input, adapter);
    const fingerprint = digest(canonical(input));
    const previous = player.requests.get(input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_REUSED', '同一请求编号不能执行不同操作。');
      if (previous.error) throw new RoomError(...previous.error);
      return { view: playerView(room, player, context) };
    }
    try {
      if (input.expectedRevision !== room.revision) fail(409, 'REVISION_CONFLICT', '房间已更新，请同步后重试。');
      if (room.phase === 'playing' && room.turnClock && now() >= room.turnClock.deadlineAt
          && !['leave', 'transferHost'].includes(input.type)) fail(409, 'TURN_TIMEOUT', '本回合时间已到，正在换人，请同步后继续。');
      const spectator=!(room.players.some(entry=>entry.id===player.id));
      if(spectator && !['leave','set-role'].includes(input.type)) fail(403,'SPECTATOR_READ_ONLY','观众可以聊天和退出，不能操作对局。');
      if(input.type==='set-role' && room.phase!=='waiting') fail(409,'ROOM_LOCKED','开局前才能切换玩家和观众。');
      if (['ready', 'start','configure'].includes(input.type) && room.phase !== 'waiting') {
        fail(409, 'ROOM_LOCKED', '对局期间不能改变席位或准备状态。');
      }
      const beforeGame = room.game;
      if(input.type==='configure') {
        const supportProblem = adapter.configurationSupportProblem(room, input);
        if (supportProblem) fail(supportProblem.status, supportProblem.code, supportProblem.message);
        if(player.id!==room.hostId) fail(403,'HOST_REQUIRED','只有房主可以更改本局规则。');
        const configuration = adapter.configure(room, input);
        if (configuration.problem) fail(configuration.problem.status, configuration.problem.code, configuration.problem.message);
        Object.assign(room, configuration.updates);room.rolesEnabled=true;for(const member of room.players) member.ready=false;
      } else if(input.type==='set-role') {
        const current=spectator?'spectator':'player';
        if(input.role===current) fail(409,'ROLE_UNCHANGED','你已是这个房间的当前身份。');
        if(input.role==='spectator' && player.id===room.hostId) fail(403,'HOST_TRANSFER_REQUIRED','请先把房主移交给另一位玩家，再转为观众。');
        joinRole(room,input.role);player.ready=false;room.rolesEnabled=true;
        if(input.role==='spectator') {room.players=room.players.filter(entry=>entry.id!==player.id);room.spectators ??= [];room.spectators.push(player);}
        else {room.spectators=room.spectators.filter(entry=>entry.id!==player.id);room.players.push(player);}
      } else if (input.type === 'ready') player.ready = input.ready;
      else if (input.type === 'start') {
        if (player.id !== room.hostId) fail(403, 'HOST_REQUIRED', '只有房主可以开始对局。');
        if (room.players.length < adapter.minPlayers || room.players.length > adapter.maxPlayers || !room.players.every((entry) => entry.ready)) {
          fail(409, 'NOT_READY', `需要${adapter.minPlayers === adapter.maxPlayers ? adapter.minPlayers : `${adapter.minPlayers}～${adapter.maxPlayers}`}人加入，且所有人准备后才能开始。`);
        }
        room.game = adapter.createGame(room.players.map(({ id, name }) => ({ id, name })), adapter.gameOptions(room, gameOptions));
        room.phase = 'playing';
        room.matchId = randomBytes(16).toString('hex'); room.matchStartedAt = now(); delete room.matchEndedAt;
        room.matchParticipants = room.players.map(({ id, userKey, name }) => ({ playerId: id, ...(userKey ? { userKey } : {}), name }));
        room.pauseVote = null; delete room.abortedResult;
        if (turnTimeoutMs > 0 && adapter.supportsTimeout(room.game)) startClock(room);
        else delete room.turnClock;
      } else if (input.type === 'rematch') {
        if (player.id !== room.hostId) fail(403, 'HOST_REQUIRED', '只有房主可以发起下一局。');
        if (!['finished', 'aborted'].includes(room.phase)) fail(409, 'GAME_NOT_FINISHED', '本局结束后才能再来一局。');
        room.game = null;
        room.phase = 'waiting';
        if (Object.hasOwn(room, 'turnClock')) room.turnClock = null;
        for (const key of ['matchId', 'matchStartedAt', 'matchEndedAt', 'matchParticipants', 'abortedResult']) delete room[key];
        room.pauseVote = null;
        for (const entry of room.players) entry.ready = false;
      } else if (input.type === 'leave') {
        const endedActiveGame = !spectator && ['playing', 'paused'].includes(room.phase);
        if(!spectator) {abort(room);room.pauseVote = null;}
        const receiptKey = player.userKey ?? player.tokenHash;
        room.leaveReceipts ??= {};
        room.leaveReceipts[receiptKey] = { fingerprint, requestId: input.requestId, at: now(), result: { view: null, left: true } };
        room.players = room.players.filter((entry) => entry.id !== player.id);
        room.spectators=(room.spectators ?? []).filter(entry=>entry.id!==player.id);
        const departing = [...(room.listeners.get(player.id) ?? [])];
        room.listeners.delete(player.id);
        if (room.hostId === player.id) {
          room.hostId = room.players.find((entry) => context.connected[entry.id])?.id ?? room.players[0]?.id ?? null;
          room.hostSinceAt = now();
          const host = room.players.find((entry) => entry.id === room.hostId);
          if (host) activity(room, player, 'transferHost', `${host.name}接任房主。`);
        }
        activity(room, player, 'leave', `${player.name}退出房间。${endedActiveGame ? '本局中止，不计输赢。' : ''}`);
        room.revision += 1;
        room.lastActiveAt = now();
        for (const listener of departing) {
          try { listener.onEnd?.('你已离开房间。'); } catch { /* Closed connection. */ }
        }
        if (!room.players.length) {finishListeners(room,'最后一位玩家已离开，房间已关闭。');room.spectators=[];room.closedAt = now(); closedRooms.set(code, room); rooms.delete(code); }
        else broadcast(room);
        return { view: null, left: true };
      } else if (input.type === 'transferHost') {
        const target = input.playerId ?? player.id;
        if (!room.players.some((entry) => entry.id === target)) fail(400, 'INVALID_PLAYER', '请选择仍在房间的玩家。');
        if (player.id !== room.hostId && (!context.hostCanTakeOver || target !== player.id)) fail(403, 'HOST_ACTIVE', '房主仍在线或正在重连，请稍后再接管。');
        if (target === room.hostId) fail(409, 'ALREADY_HOST', '这位玩家已经是房主。');
        room.hostId = target; room.hostSinceAt = now();
      } else if (input.type === 'pause') {
        if (room.phase !== 'playing') fail(409, 'GAME_NOT_PLAYING', '只有进行中的对局可以暂停。');
        room.pauseVote ??= { requestedBy: player.id, agreedIds: [] };
        room.pauseVote.agreedIds = room.pauseVote.agreedIds.filter((id) => id !== player.id);
        if (input.agree !== false) room.pauseVote.agreedIds.push(player.id);
        if (!room.pauseVote.agreedIds.length) room.pauseVote = null;
        else if (room.players.every((entry) => room.pauseVote.agreedIds.includes(entry.id))) { room.phase = 'paused'; room.pauseVote = null; }
      } else if (input.type === 'resume') {
        if (room.phase !== 'paused') fail(409, 'GAME_NOT_PAUSED', '当前对局没有暂停。');
        room.phase = 'playing'; room.pauseVote = null;
      } else {
        if (room.phase !== 'playing') fail(409, room.phase === 'paused' ? 'GAME_PAUSED' : 'GAME_NOT_PLAYING', room.phase === 'paused' ? '对局已暂停，继续后才能出牌。' : '当前没有进行中的对局。');
        const result = adapter.applyGameAction(room.game, player.id, input);
        if (!result.ok) fail(409, 'INVALID_GAME_ACTION', result.error);
        room.game = result.state;
        if (room.game.status === 'finished') { room.phase = 'finished'; room.pauseVote = null; conclude(room, 'completed', room.game.result.reason); }
      }
      syncClock(room);
      const texts = {
        'set-role':`${player.name}切换为${input.role==='player'?'玩家':'观众'}。`,
        ready: `${player.name}${input.ready ? '已准备。' : '取消准备。'}`,
        start: `${player.name}开始了新一局。`, rematch: `${player.name}发起再来一局，等待大家准备。`,
        pause: room.phase === 'paused' ? '所有成员已同意，对局暂停。'
          : `${player.name}${input.agree === false ? '取消同意暂停。' : '同意暂停，等待其他成员确认。'}`,
        resume: `${player.name}继续了对局。`,
        transferHost: `${room.players.find((entry) => entry.id === room.hostId)?.name}成为房主。`,
      };
      activity(room, player, input.type, texts[input.type] ?? adapter.describeAction({ action: input, player, beforeGame, afterGame: room.game }));
      if (room.phase === 'finished' && adapter.actionFields(input.type) !== null) activity(room, null, 'finished', '本局已结束，结算已保存。');
      room.revision += 1;
      if (input.type !== 'pause' || room.phase === 'paused') room.lastActiveAt = now();
      player.requests.set(input.requestId, { fingerprint });
      broadcast(room);
      return { view: playerView(room, player, context) };
    } catch (error) {
      if (!(error instanceof RoomError)) error = new RoomError(400, 'INVALID_GAME', error.message || '游戏状态无效。');
      player.requests.set(input.requestId, { fingerprint, error: [error.status, error.code, error.message] });
      throw error;
    } finally {
      while (player.requests.size > 128) player.requests.delete(player.requests.keys().next().value);
    }
  }
  // Internal server operation only. No HTTP action can request a skip or bypass a deadline.
  function applyTurnTimeout(code, fence) {
    const room = rooms.get(code), clock = room?.turnClock;
    if (!clock || room.phase !== 'playing' || now() < clock.deadlineAt || now() >= expiry(room)
        || !fence || ['matchId', 'round', 'playerId', 'deadlineAt'].some((key) => fence[key] !== clock[key])) return false;
    const player = room.players.find(({ id }) => id === clock.playerId), adapter = adapterFor(room);
    const timeoutText = adapter.describeTimeout(room.game, player);
    const result = adapter.applyTimeout(room.game, clock.playerId);
    if (!result.ok) fail(500, 'INVALID_TIMEOUT', result.error);
    room.game = result.state;
    if (room.game.status === 'finished') { room.phase = 'finished'; room.pauseVote = null; conclude(room, 'completed', room.game.result.reason); }
    activity(room, player, 'timeout', timeoutText);
    if (room.phase === 'finished') activity(room, null, 'finished', '本局已结束，结算已保存。');
    syncClock(room); room.revision += 1; broadcast(room);
    return true;
  }
  function action(code, token, input) {
    const replay = replayLeave(code, typeof token === 'string' ? digest(token) : null, input);
    if (replay) return replay;
    const room = getRoom(code);
    return act(room, authenticate(room, token), input);
  }
  function replayLeave(code, key, input) {
    const room = rooms.get(code) ?? closedRooms.get(code), receipt = room?.leaveReceipts?.[key];
    if (!receipt || input?.requestId !== receipt.requestId || now() - receipt.at >= leaveRetentionMs) return null;
    validateAction(input, adapterFor(room));
    if (digest(canonical(input)) !== receipt.fingerprint) fail(409, 'REQUEST_ID_REUSED', '同一请求编号不能执行不同操作。');
    return structuredClone(receipt.result);
  }
  // These methods are server-only. HTTP callers must never supply userKey themselves.
  function trustedPlayer(room, userKey) {
    if (typeof userKey !== 'string' || !/^[a-f0-9]{64}$/.test(userKey)) {
      fail(401, 'INVALID_IDENTITY', '请重新登录棋牌。');
    }
    const player = members(room).find((candidate) => candidate.userKey === userKey);
    if (!player) fail(403, 'SEAT_REQUIRED', '请先加入这个房间。');
    return player;
  }
  function membership(room, player) {
    return { roomCode: room.code, playerId: player.id, view: playerView(room, player) };
  }
  function createTrustedRoom(userKey, name, { code, roomId, gameType = 'rummikub' } = {}) {
    gameType = roomType(gameType);
    if (typeof userKey !== 'string' || !/^[a-f0-9]{64}$/.test(userKey)) fail(401, 'INVALID_IDENTITY', '请重新登录棋牌。');
    if (typeof code !== 'string' || !/^\d{6}$/.test(code) || typeof roomId !== 'string' || !/^[a-f0-9]{32}$/.test(roomId)) {
      fail(400, 'INVALID_ROOM_ID', '房间标识无效。');
    }
    if (rooms.has(code) || closedRooms.has(code)) fail(409, 'ROOM_EXISTS', '房间已经存在。');
    const { player } = makePlayer(name, userKey);
    const room = { code, roomId, gameType, hostId: player.id, phase: 'waiting', revision: 0,
      players: [player], game: null, listeners: new Map(), lastActiveAt: now(), hostSinceAt: now(), leaveReceipts: {}, pendingRecords: [] };
    rooms.set(code, room);
    return membership(room, player);
  }
  function joinRole(room,role) {
    if(role!==undefined && !['player','spectator'].includes(role)) fail(400,'INVALID_ROLE','请选择玩家或观众。');
    const resolved=room.phase==='waiting'?(role ?? 'player'):'spectator';
    if(resolved==='player' && room.players.length>=adapterFor(room).maxPlayers) fail(409,'ROOM_FULL',`这个房间最多容纳${adapterFor(room).maxPlayers}位玩家。`);
    if(resolved==='spectator' && (room.spectators ?? []).length>=SPECTATOR_CAPACITY) fail(409,'SPECTATOR_FULL',`这个房间最多容纳${SPECTATOR_CAPACITY}位观众。`);
    return resolved;
  }
  function joinTrustedRoom(code, userKey, name, {role}={}) {
    const room = getRoom(code);
    // Recover the same account's existing seat even after the game has begun.
    const existing = members(room).find((candidate) => candidate.userKey === userKey);
    if (existing) return membership(room, trustedPlayer(room, userKey));
    if (typeof userKey !== 'string' || !/^[a-f0-9]{64}$/.test(userKey)) fail(401, 'INVALID_IDENTITY', '请重新登录棋牌。');
    const joiningRole=joinRole(room,role);
    const { player } = makePlayer(name, userKey);
    if(joiningRole==='player') room.players.push(player);else {room.rolesEnabled=true;room.spectators ??= [];room.spectators.push(player);}
    room.revision += 1;
    room.lastActiveAt = now();
    broadcast(room);
    return membership(room, player);
  }
  function getTrustedView(code, userKey, context) {
    const room = getRoom(code);
    return playerView(room, trustedPlayer(room, userKey), context);
  }
  function trustedAction(code, userKey, input, context) {
    const replay = replayLeave(code, userKey, input);
    if (replay) return replay;
    const room = getRoom(code);
    return act(room, trustedPlayer(room, userKey), input, context);
  }
  function exportSnapshot(code) {
    const room = rooms.get(code) ?? closedRooms.get(code);
    if (!room) return null;
    return serializeRoomSnapshot(room, adapterFor(room));
  }
  function expireRoom(code) {
    const room = rooms.get(code);
    if (!room) return null;
    abort(room, 'expired');
    return exportSnapshot(code);
  }
  function importSnapshot(snapshot) {
    const data = structuredClone(snapshot);
    const hasRoles = snapshotHasRoles(data);
    let adapter;
    try { adapter = gameRegistry.gameAdapter(snapshotGameType(data), { gameEngine }); }
    catch { fail(500, 'INVALID_SNAPSHOT', '房间保存内容无效。'); }
    if (snapshotFormatProblem(data, adapter)
        || hasRoles && data.spectators.length > SPECTATOR_CAPACITY        || !/^\d{6}$/.test(data.code)
        || !['waiting', 'playing', 'paused', 'finished', 'aborted'].includes(data.phase)
        || !Number.isSafeInteger(data.revision) || data.revision < 0
        || !Number.isFinite(data.lastActiveAt) || !Array.isArray(data.players)
        || !data.players.length || data.players.length > adapter.maxPlayers
        || new Set(members(data).map((player) => player.id)).size !== members(data).length
        || members(data).some((player) => !/^[a-f0-9]{32}$/.test(player.id)
          || (player.userKey && !/^[a-f0-9]{64}$/.test(player.userKey))
          || !Array.isArray(player.requests) || player.requests.length > 128)
        || new Set(members(data).filter((player) => player.userKey).map((player) => player.userKey)).size
          !== members(data).filter((player) => player.userKey).length
        || !data.players.some((player) => player.id === data.hostId)) {
      fail(500, 'INVALID_SNAPSHOT', '房间保存内容无效。');
    }
    if (data.schemaVersion === 1 && !['waiting', 'playing', 'finished'].includes(data.phase)
        || ['playing', 'paused', 'finished', 'aborted'].includes(data.phase) && !data.game
        || data.phase === 'waiting' && data.game !== null
        || data.game && data.game.status !== (data.phase === 'finished' ? 'finished' : 'playing')
        || data.hostSinceAt !== undefined && !Number.isFinite(data.hostSinceAt)
        || data.matchId !== undefined && !/^[a-f0-9]{32}$/.test(data.matchId)
        || data.matchStartedAt !== undefined && data.matchStartedAt !== null && !Number.isFinite(data.matchStartedAt)
        || data.matchEndedAt !== undefined && data.matchEndedAt !== null && !Number.isFinite(data.matchEndedAt)
        || data.activitySequence !== undefined && (!Number.isSafeInteger(data.activitySequence) || data.activitySequence < 0)
        || data.activity !== undefined && (!Array.isArray(data.activity) || data.activity.length > 40 || data.activity.some((entry, index) =>
          !entry || Object.keys(entry).some((key) => !['sequence', 'id', 'at', 'actorName', 'type', 'text'].includes(key))
          || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > (data.activitySequence ?? 0)
          || index > 0 && entry.sequence <= data.activity[index - 1].sequence
          || entry.id !== `${data.code}:${entry.sequence}` || !Number.isFinite(entry.at) || !activityTypes.has(entry.type)
          || typeof entry.actorName !== 'string' || [...entry.actorName].length > 16 || /\p{Cc}/u.test(entry.actorName)
          || typeof entry.text !== 'string' || entry.text.length > 160 || /\p{Cc}/u.test(entry.text)))
        || data.pendingRecords !== undefined && (!Array.isArray(data.pendingRecords) || data.pendingRecords.some((record) => !/^[a-f0-9]{32}$/.test(record.matchId ?? '') || !['completed', 'aborted'].includes(record.status)))
        || data.phase === 'aborted' && (!data.abortedResult?.aborted || data.abortedResult.winnerIds?.length || data.abortedResult.scores?.length)
        || data.pauseVote && (data.phase !== 'playing' || !Array.isArray(data.pauseVote.agreedIds)
          || !data.players.some((player) => player.id === data.pauseVote.requestedBy)
          || new Set(data.pauseVote.agreedIds).size !== data.pauseVote.agreedIds.length
          || data.pauseVote.agreedIds.some((id) => !data.players.some((player) => player.id === id)))) {
      fail(500, 'INVALID_SNAPSHOT', '房间保存的生命周期无效。');
    }
    data.gameType = adapter.gameType;
    if (data.schemaVersion === 7 || data.schemaVersion === 8 && Object.hasOwn(data,'turnClock')) {
      const clock = data.turnClock;
      const fields = ['version','durationMs','remainingMs','startedAt','deadlineAt','pausedAt','firstPlayerId','matchId','round','playerId'];
      if (['playing','paused'].includes(data.phase) ? !clock || Object.keys(clock).length !== fields.length
          || Object.keys(clock).some((key)=>!fields.includes(key)) || clock.version!==1
          || !Number.isSafeInteger(clock.durationMs) || clock.durationMs<=0 || clock.durationMs>24*60*60*1000
          || !Number.isFinite(clock.remainingMs) || clock.remainingMs<0 || clock.remainingMs>clock.durationMs
          || !Number.isFinite(clock.startedAt) || clock.matchId!==data.matchId || clock.round!==data.game.round
          || clock.playerId!==data.game.players[data.game.turnIndex]?.id
          || !data.game.players.some(({id})=>id===clock.firstPlayerId)
          || !adapter.supportsTimeout(data.game)
          || (data.phase==='paused' ? !Number.isFinite(clock.pausedAt) || clock.deadlineAt!==null
            : clock.pausedAt!==null || !Number.isFinite(clock.deadlineAt) || clock.deadlineAt!==clock.startedAt+clock.remainingMs)
          : clock!==null) fail(500,'INVALID_SNAPSHOT','房间保存的回合时钟无效。');
    }
    const stateProblem = adapter.roomStateProblem(data, hasRoles);
    if (stateProblem) fail(500, 'INVALID_SNAPSHOT', stateProblem);
    data.rolesEnabled=hasRoles;
    delete data.schemaVersion;
    data.players = data.players.map((player) => ({ ...player, name: validateName(player.name),
      requests: new Map(player.requests) }));
    data.spectators=(data.spectators ?? []).map(player=>({...player,name:validateName(player.name),ready:false,requests:new Map(player.requests)}));
    if (data.game) {
      try {
        const adapter = adapterFor(data);
        if (adapter.stateProblem(data.game)) throw new Error('Invalid game');
        if (!Array.isArray(data.game.players) || data.players.some((player) => !data.game.players.some((entry) => entry.id === player.id))
            || ['playing', 'paused'].includes(data.phase) && data.players.length !== data.game.players.length) throw new Error('Invalid seats');
        adapter.privateView(data.game, data.players[0].id);
      }
      catch { fail(500, 'INVALID_SNAPSHOT', '房间保存的对局或规则版本无效。'); }
    }
    data.listeners = new Map();
    data.leaveReceipts ??= {}; data.pendingRecords ??= []; data.hostSinceAt ??= data.lastActiveAt;
    ensureMatch(data);
    // A legacy result predates this archive system. Preserve it in-room without inventing its end time or historical record.
    if (data.phase === 'finished' && data.matchEndedAt === undefined) data.matchEndedAt = null;
    rooms.set(data.code, data);
  }
  function subscribe(code, token, onView, onEnd) {
    const room = getRoom(code);
    const player = authenticate(room, token);
    let listeners = room.listeners.get(player.id);
    if (!listeners) { listeners = new Set(); room.listeners.set(player.id, listeners); }
    if (listeners.size >= 4) fail(429, 'CONNECTION_LIMIT', '这个席位连接过多，请关闭重复页面。');
    if([...room.listeners.values()].reduce((sum,set)=>sum+set.size,0)>=16) fail(429,'ROOM_CONNECTION_LIMIT','房间连接已满，请关闭重复页面后重试。');
    const listener = { onView, onEnd };
    listeners.add(listener);
    room.lastSeen ??= {}; room.lastSeen[player.id] = now();
    broadcast(room);
    return () => {
      if (!listeners.delete(listener)) return;
      room.lastSeen[player.id] = now();
      if (!listeners.size) room.listeners.delete(player.id);
      if (rooms.get(code) === room) broadcast(room);
    };
  }
  function close() {
    for (const room of rooms.values()) finishListeners(room, '本机服务已停止。');
    rooms.clear();
    closedRooms.clear();
  }
  return { createRoom, joinRoom, getView, action, subscribe, sweep, close,
    createTrustedRoom, joinTrustedRoom, getTrustedView, trustedAction, exportSnapshot, importSnapshot, expireRoom, applyTurnTimeout };
}
