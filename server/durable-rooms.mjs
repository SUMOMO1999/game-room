import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createRoomStore, RoomError, DEFAULT_TURN_TIMEOUT_MS } from '../app/rooms.mjs';
import { defaultGameRegistry } from '../app/game-registry.mjs';
import { snapshotGameType, snapshotAuthorityBindingProblem } from './room-snapshot-compat.mjs';
import { createRoomScoreCommitter } from './room-score-commit.mjs';
import { ScoreError } from './game-scores.mjs';
import { roomExpiry } from './games/adapter-contract.mjs';

const FOREVER = Number.MAX_SAFE_INTEGER;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const copy = (value) => structuredClone(value);
const members=snapshot=>[...snapshot.players,...(snapshot.spectators ?? [])];
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
function fail(status, code, message) { throw new RoomError(status, code, message); }
function identity(userKey) {
  if (typeof userKey !== 'string' || !/^[a-f0-9]{64}$/.test(userKey)) fail(401, 'INVALID_IDENTITY', '请重新登录棋牌。');
  return userKey;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(400, 'INVALID_REQUEST_ID', '操作需要有效的请求编号。');
  return value;
}
function nickname(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_NAME', '请填写你的称呼。');
  const name = value.normalize('NFC').trim();
  if (!name || [...name].length > 16 || /\p{Cc}/u.test(name)) fail(400, 'INVALID_NAME', '称呼需要1～16个字，不能包含控制字符。');
  return name;
}

/** Only a BFF-verified identity may enter this server-only API. Never accept userKey from an HTTP body. */
export function createDurableRoomStore({ storage, now = Date.now, ttlMs = 8 * 60 * 60 * 1000,
  pausedTtlMs = 7 * 24 * 60 * 60 * 1000, leaveRetentionMs = 24 * 60 * 60 * 1000, hostTakeoverGraceMs = 60000,
  maxRooms = 100, gameOptions = {}, gameEngine, pollIntervalMs = 1000, presenceTtlMs = 10000,
  maxCasAttempts = 100, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS, gameRegistry = defaultGameRegistry,
  serverRandomInt = randomInt, scores, transitionPreparers, prepareRoom = async snapshot => snapshot, prepareAction = async () => ({}) } = {}) {
  if (!storage?.read || !storage?.replaceCAS || !storage?.guardedCAS || !storage?.putIfAbsent || !storage?.remove) throw new TypeError('Durable rooms require an atomic encrypted store.');
  if (!(ttlMs > 0) || !(presenceTtlMs > 0) || !(maxRooms > 0)) throw new TypeError('Invalid room limits.');
  const local = new Map(), authorityMetadata = new Map();
  let closed = false;
  let pollingFlight = null;
  let history = null, historyFlight = null;
  const commitWithScores = createRoomScoreCommitter({ storage, gameRegistry, now, scores, transitionPreparers });
  async function commitRoom(...args) {
    try { return await commitWithScores(...args); }
    catch (error) {
      if (error instanceof ScoreError) throw new RoomError(error.status, error.code, error.message);
      throw error;
    }
  }
  const adapterFor = snapshot => gameRegistry.gameAdapter(snapshotGameType(snapshot));
  const attemptsFor = snapshot => Math.min(maxCasAttempts, adapterFor(snapshot).businessCasAttempts ?? maxCasAttempts);
  const expiry = snapshot => roomExpiry(snapshot, adapterFor(snapshot), { ttlMs, pausedTtlMs });
  function engine(snapshot, preparedOptions = {}) {
    const store = createRoomStore({ now, ttlMs, pausedTtlMs, leaveRetentionMs, gameOptions: { ...gameOptions, ...preparedOptions }, turnTimeoutMs,
      gameRegistry, serverRandomInt, ...(gameEngine ? { gameEngine } : {}) });
    if (snapshot) store.importSnapshot(snapshot);
    return store;
  }
  function terminalRecord(record, reason) {
    const snapshot = record.snapshot ? engine(record.snapshot).expireRoom(record.snapshot.code) : null;
    return { snapshot: null, roomCode: record.snapshot?.code ?? record.roomCode, deletedAt: now(), reason,
      leaveReceipts: record.leaveReceipts ?? {}, pendingRecords: [...(record.pendingRecords ?? []), ...(snapshot?.pendingRecords ?? [])] };
  }
  async function cas(scope, id, change, expiresAt = FOREVER) {
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      const previous = await storage.read(scope, id);
      const next = await change(previous?.value ?? null);
      if (next === undefined) return previous?.value ?? null;
      if (previous ? await storage.replaceCAS(scope, id, previous.version, next, expiresAt)
        : await storage.putIfAbsent(scope, id, next, expiresAt)) return next;
    }
    fail(503, 'STORE_BUSY', '房间正在同步，请稍后重试。');
  }
  async function ensureProfile(userKey, initialName) {
    identity(userKey);
    const name = initialName === undefined || initialName === null ? null : nickname(initialName);
    return copy(await cas('game-profiles', userKey, (previous) => previous ? undefined : {
      userKey, nickname: name, createdAt: now(), updatedAt: now(),
    }));
  }
  async function setProfile(userKey, name) {
    identity(userKey);
    name = nickname(name);
    return copy(await cas('game-profiles', userKey, (previous) => ({
      ...(previous ?? { userKey, createdAt: now() }), nickname: name, updatedAt: now(),
    })));
  }
  async function resolvedRoom(code) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
    const invitation = await storage.read('room-invites', code);
    if (invitation?.value.retired) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
    const roomId = invitation?.value.roomId;
    const invitationGuard = invitation ? { scope: 'room-invites', id: code, expectedVersion: invitation.version } : null;
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      let record = roomId ? await storage.read('rooms', roomId) : null;
      if (record?.value.snapshot && adapterFor(record.value.snapshot).usesPresenceLifecycle) {
        await reconcileLifecycle(roomId);
        record = await storage.read('rooms', roomId);
      }
      // Storage revisions, rather than the game's business revision, identify
      // a validated snapshot. Missing/corrupt or replaced rows invalidate it.
      if (authorityMetadata.get(roomId)?.version !== record?.version) authorityMetadata.delete(roomId);
      if (!record?.value.snapshot) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
      if (now() < expiry(record.value.snapshot)) return { roomId, record, invitationGuard };
      // An action or pause may have committed after this read. A failed expiry CAS must retry the new room.
      if (await commitRoom(roomId, record, terminalRecord(record.value, 'expired'))) {
        fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
      }
    }
    fail(503, 'STORE_BUSY', '房间正在同步，请稍后重试。');
  }
  function presenceData(value) {
    const data = value?.schemaVersion === 2 ? value : { schemaVersion: 2, connections: value ?? {}, lastSeen: {} };
    data.leaseExpiresAt ??= {}; data.absenceSinceAt ??= {};
    return data;
  }
  async function context(snapshot) {
    const record = await storage.read('room-presence', snapshot.roomId), value = presenceData(record?.value);
    const observedAt = now();
    const connected = Object.fromEntries(Object.entries(value.connections).map(([playerId, connections]) => [playerId,
      Object.values(connections).some((until) => until > observedAt)]));
    const seats = (snapshot.matchParticipants ?? snapshot.players?.map(({ id }) => ({ playerId: id })) ?? []).map(({ playerId }) => {
      const leases = Object.values(value.connections[playerId] ?? {});
      const latest = Math.max(value.leaseExpiresAt[playerId] ?? 0, ...leases);
      const online = leases.some(until => until > observedAt);
      return { playerId, connected: online, lastSeenAt: value.lastSeen[playerId] ?? null,
        leaseExpiresAt: latest || null,
        absenceSinceAt: online ? null : value.absenceSinceAt[playerId] ?? (latest && latest <= observedAt ? latest : null) };
    });
    return { connected, hostCanTakeOver: !connected[snapshot.hostId]
      && now() >= Math.max(snapshot.hostSinceAt ?? snapshot.lastActiveAt, value.lastSeen[snapshot.hostId] ?? 0) + presenceTtlMs + hostTakeoverGraceMs,
      presence: { observedAt, seats }, presenceRecord: record };
  }
  function presenceGuards(roomId, trusted) {
    const onlineLeases = trusted.presence.seats.filter(seat => seat.connected).map(seat => seat.leaseExpiresAt);
    return [{ scope: 'room-presence', id: roomId, expectedVersion: trusted.presenceRecord?.version ?? null,
      validUntil: onlineLeases.length ? Math.min(...onlineLeases) : FOREVER }];
  }
  async function presence(roomId) {
    const value = presenceData((await storage.read('room-presence', roomId))?.value);
    return Object.fromEntries(Object.entries(value.connections).map(([playerId, connections]) => [playerId, Object.values(connections).some((until) => until > now())]));
  }
  function project(snapshot, userKey, trustedContext = { connected: {}, hostCanTakeOver: false }) {
    const projection = engine(snapshot);
    try { return projection.getTrustedView(snapshot.code, userKey, trustedContext); }
    finally { projection.close(); }
  }
  async function membership(snapshot, userKey) {
    const view = project(snapshot, userKey, await context(snapshot));
    return { roomCode: snapshot.code, playerId: view.selfId, view };
  }
  async function rememberRoom(snapshot, userKey) {
    const seat = members(snapshot).find((player) => player.userKey === userKey);
    if (!seat) return;
    await cas('room-memberships', userKey, (previous) => {
      const order = Math.max(0, ...Object.values(previous ?? {}).map((entry) => entry.order ?? 0)) + 1;
      const next = { ...(previous ?? {}), [snapshot.roomId]: {
        roomCode: snapshot.code, playerId: seat.id, at: now(), order,
      } };
      return Object.fromEntries(Object.entries(next).sort((a, b) => b[1].order - a[1].order).slice(0, 8));
    });
  }
  async function recentRooms(userKey) {
    identity(userKey);
    const index = (await storage.read('room-memberships', userKey))?.value ?? {};
    const rooms = [];
    const stale = [];
    for (const [roomId, entry] of Object.entries(index)) {
      try {
        const view = await getView(entry.roomCode, userKey);
        if (view.selfId === entry.playerId) rooms.push({ roomCode: entry.roomCode, playerId: entry.playerId,
          at: entry.at, order: entry.order, phase: view.phase, updatedAt: view.expiresAt - (view.phase === 'paused' ? pausedTtlMs : ttlMs),
          expiresAt: view.expiresAt, playersCount: view.players.length, connectedCount: view.players.filter((player) => player.connected).length,
          hostName: view.players.find((player) => player.id === view.hostId)?.name,
          name: [...view.players,...(view.spectators ?? [])].find((player) => player.id === view.selfId)?.name,
          selfRole:view.selfRole,spectatorsCount:view.spectators?.length ?? 0,
          gameType: view.gameType, minPlayers: view.minPlayers, maxPlayers: view.maxPlayers });
        else stale.push([roomId, entry]);
      } catch (error) {
        if (!(error instanceof RoomError) || !['ROOM_NOT_FOUND', 'SEAT_REQUIRED'].includes(error.code)) throw error;
        stale.push([roomId, entry]);
      }
    }
    if (stale.length) await cas('room-memberships', userKey, (previous) => {
      const next = { ...(previous ?? {}) }; let changed = false;
      for (const [roomId, entry] of stale) if (canonical(next[roomId]) === canonical(entry)) { delete next[roomId]; changed = true; }
      return changed ? next : undefined;
    });
    return rooms.sort((a, b) => b.order - a.order).slice(0, 8).map(({ order, ...entry }) => entry);
  }
  async function collectExpired(roomId, record, reservedAt) {
    if (!record) return now() - reservedAt >= 60000;
    if (!record.value.snapshot) return true;
    if (adapterFor(record.value.snapshot).usesPresenceLifecycle) {
      await reconcileLifecycle(roomId);
      record = await storage.read('rooms', roomId);
      if (!record?.value.snapshot) return true;
    }
    if (now() < expiry(record.value.snapshot)) return false;
    // A concurrent valid action may have renewed the room; never remove its capacity reservation on a failed CAS.
    return commitRoom(roomId, record, terminalRecord(record.value, 'expired'));
  }
  async function reserveRoom(roomId, code) {
    await cas('room-registry', 'active', async (previous) => {
      const entries = { ...(previous ?? {}) };
      if (entries[roomId]) return undefined;
      for (const [id, entry] of Object.entries(entries)) {
        const record = await storage.read('rooms', id);
        if (await collectExpired(id, record, entry.reservedAt)) delete entries[id];
      }
      if (Object.keys(entries).length >= maxRooms) fail(503, 'ROOM_LIMIT', '房间已满，请稍后再试。');
      entries[roomId] = { code, reservedAt: now() };
      return entries;
    });
  }
  async function createRoom(userKey, name, id, gameType = 'rummikub') {
    identity(userKey); requestId(id); name = nickname(name);
    try { gameType = gameRegistry.normalizeGameType(gameType); }
    catch { fail(400, 'INVALID_GAME_TYPE', '请选择支持的游戏。'); }
    await ensureProfile(userKey);
    const operationKey = hash(`${userKey}\0create\0${id}`);
    // Default Rummikub retains the historical fingerprint, including pending
    // create markers retried across a deployment. Other games bind their kind.
    const fingerprint = hash(canonical(gameType === 'rummikub' ? { name } : { name, gameType }));
    let operation;
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      const previous = await storage.read('room-requests', operationKey);
      if (previous) { operation = previous.value; break; }
      const roomId = randomBytes(16).toString('hex');
      const code = String(randomInt(1000000)).padStart(6, '0');
      if (!(await storage.putIfAbsent('room-invites', code, { roomId }, FOREVER))) continue;
      const roomEngine = engine();
      roomEngine.createTrustedRoom(userKey, name, { code, roomId, gameType });
      const snapshot = await prepareRoom(roomEngine.exportSnapshot(code), userKey, { expiresAt: now() + pausedTtlMs });
      // Validate trusted content assembly before a pending create becomes durable.
      engine(snapshot);
      const proposal = { kind: 'create', fingerprint, roomId, code, status: 'pending', snapshot };
      if (await storage.putIfAbsent('room-requests', operationKey, proposal, now() + leaveRetentionMs)) { operation = proposal; break; }
      // A losing request's invitation remains a tombstone. Old invitation codes never point at a new room.
    }
    if (!operation) fail(503, 'STORE_BUSY', '房间正在同步，请稍后重试。');
    if (operation.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_REUSED', '同一请求编号不能执行不同操作。');
    if (operation.status === 'pending') {
      if ((await storage.read('room-invites', operation.code))?.value.retired) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
      await reserveRoom(operation.roomId, operation.code);
      const initial = copy(operation.snapshot);
      initial.lastActiveAt = now();
      await storage.putIfAbsent('rooms', operation.roomId, { snapshot: initial, joins: {} }, FOREVER);
      await cas('room-requests', operationKey, (previous) => previous.status === 'done' ? undefined : {
        kind: 'create', fingerprint, roomId: operation.roomId, code: operation.code, status: 'done',
      }, now() + leaveRetentionMs);
    }
    const { record } = await resolvedRoom(operation.code);
    await setProfile(userKey, name);
    await rememberRoom(record.value.snapshot, userKey);
    return membership(record.value.snapshot, userKey);
  }
  async function joinRoom(code, userKey, name, id, role) {
    identity(userKey); requestId(id); name = nickname(name);
    if(role!==undefined && !['player','spectator'].includes(role)) fail(400,'INVALID_ROLE','请选择玩家或观众。');
    await ensureProfile(userKey);
    const fingerprint = hash(canonical(role===undefined?{name}:{name,role}));
    const joinKey = hash(`${userKey}\0${id}`);
    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      const { roomId, record } = await resolvedRoom(code);
      const room = record.value;
      if (room.joins[joinKey]) {
        if (room.joins[joinKey].fingerprint !== fingerprint) fail(409, 'REQUEST_ID_REUSED', '同一请求编号不能执行不同操作。');
        if (room.joins[joinKey].error) throw new RoomError(...room.joins[joinKey].error);
        await setProfile(userKey, name);
        await rememberRoom(room.snapshot, userKey);
        return membership(room.snapshot, userKey);
      }
      const roomEngine = engine(room.snapshot);
      let error;
      try { roomEngine.joinTrustedRoom(code, userKey, name,{role}); }
      catch (failure) { if (!(failure instanceof RoomError)) throw failure; error = failure; }
      room.snapshot = roomEngine.exportSnapshot(code);
      room.joins[joinKey] = { fingerprint, ...(error ? { error: [error.status, error.code, error.message] } : {}) };
      while (Object.keys(room.joins).length > 1024) delete room.joins[Object.keys(room.joins)[0]];
      if (!(await storage.replaceCAS('rooms', roomId, record.version, room, FOREVER))) continue;
      if (error) throw error;
      await publish(roomId);
      await setProfile(userKey, name);
      await rememberRoom(room.snapshot, userKey);
      return membership(room.snapshot, userKey);
    }
    fail(503, 'STORE_BUSY', '房间正在同步，请稍后重试。');
  }
  async function getView(code, userKey) {
    identity(userKey);
    const { roomId, record } = await resolvedRoom(code);
    return project(record.value.snapshot, userKey, await context(record.value.snapshot));
  }
  async function getChatMember(code, userKey) {
    identity(userKey);
    if (closed) fail(503, 'STORE_CLOSED', '服务正在重启，请稍后重试。');
    const { roomId, record } = await resolvedRoom(code);
    if (closed) fail(503, 'STORE_CLOSED', '服务正在重启，请稍后重试。');
    const authority = roomAuthority(roomId, code, record);
    const member = authority.members.find(player => player.userKey === userKey);
    if (!member) fail(403, 'SEAT_REQUIRED', '请先加入这个房间。');
    const profile = (await storage.read('game-profiles', userKey))?.value;
    if (closed) fail(503, 'STORE_CLOSED', '服务正在重启，请稍后重试。');
    if (now() >= authority.expiresAt) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
    // The cache holds only validated member metadata. The current saved game
    // stays local to this call so a new question cannot reuse an old answer gate.
    const game = record.value.snapshot.game, adapter = gameRegistry.gameAdapter(authority.gameType);
    return { roomId, playerId: member.seatId, name: profile?.nickname || member.name,
      ...(typeof adapter.chatProblem === 'function' && game
        ? { chatProblem: text => adapter.chatProblem(game, text) } : {}),
      guard: { scope: 'rooms', id: roomId, version: record.version, validUntil: authority.expiresAt } };
  }
  // Server-only context for domain services which must commit against the
  // same saved room and membership. No HTTP handler serializes this object.
  function roomAuthority(roomId, code, record) {
    const cached = authorityMetadata.get(roomId);
    if (cached?.version === record.version && cached.code === code) {
      authorityMetadata.delete(roomId); authorityMetadata.set(roomId, cached);
      return cached.value;
    }
    authorityMetadata.delete(roomId);
    const snapshot = record.value.snapshot, validator = engine();
    try {
      // Keep the complete import contract, including private-view validation.
      // Import may add legacy defaults: metadata intentionally uses the original
      // saved snapshot instead of exporting or retaining the temporary engine.
      validator.importSnapshot(snapshot);
      if (snapshotAuthorityBindingProblem(snapshot, { roomId, code })) {
        fail(500, 'INVALID_SNAPSHOT', '房间保存的标识无效。');
      }
    } catch (error) {
      if (error instanceof RoomError && error.code === 'INVALID_SNAPSHOT') throw error;
      fail(500, 'INVALID_SNAPSHOT', '房间保存内容无效。');
    } finally { validator.close(); }
    const game = snapshot.game;
    const value = Object.freeze({
      gameType: adapterFor(snapshot).gameType,
      members: Object.freeze([
        ...snapshot.players.map(player => Object.freeze({ userKey: player.userKey, seatId: player.id, role: 'player', name: nickname(player.name) })),
        ...(snapshot.spectators ?? []).map(player => Object.freeze({ userKey: player.userKey, seatId: player.id, role: 'spectator', name: nickname(player.name) })),
      ]),
      matchId: snapshot.matchId ?? null, turnId: game?.turnId ?? null,
      phase: game?.stage ?? snapshot.phase, roomPhase: snapshot.phase,
      drawerSeatId: game?.turnPlayerId ?? null,
      deadline: game?.stageClock?.deadlineAt ?? snapshot.turnClock?.deadlineAt ?? null,
      paused: snapshot.phase === 'paused', expiresAt: expiry(snapshot),
    });
    authorityMetadata.set(roomId, Object.freeze({ version: record.version, code, value }));
    if (authorityMetadata.size > 64) authorityMetadata.delete(authorityMetadata.keys().next().value);
    return value;
  }
  async function getGameContext(code, userKey, { includeView = true } = {}) {
    identity(userKey);
    if (!includeView && closed) fail(503, 'STORE_CLOSED', '服务正在重启，请稍后重试。');
    const { roomId, record, invitationGuard } = await resolvedRoom(code);
    const snapshot = record.value.snapshot;
    if (!includeView) {
      if (closed) fail(503, 'STORE_CLOSED', '服务正在重启，请稍后重试。');
      const authority = roomAuthority(roomId, code, record), trusted = await context({ roomId,
        hostId: snapshot.hostId, hostSinceAt: snapshot.hostSinceAt, lastActiveAt: snapshot.lastActiveAt });
      if (closed) fail(503, 'STORE_CLOSED', '服务正在重启，请稍后重试。');
      // The full path reaches getRoom's TTL sweep after presence has awaited.
      // Match that fence here without turning an elapsed drawing deadline into
      // loss of read-only recovery access to the saved canvas.
      if (now() >= authority.expiresAt) fail(404, 'ROOM_NOT_FOUND', '房间不存在或已失效。');
      const member = authority.members.find(player => player.userKey === userKey);
      if (!member) fail(403, 'SEAT_REQUIRED', '请先加入这个房间。');
      return {
        roomId, seatId: member.seatId, role: member.role, gameType: authority.gameType,
        roomRecord: { version: record.version, expiresAt: record.expiresAt },
        invitationGuard,
        roomGuard: { scope: 'rooms', id: roomId, expectedVersion: record.version },
        presenceGuard: { scope: 'room-presence', id: roomId,
          expectedVersion: trusted.presenceRecord?.version ?? null, validUntil: authority.expiresAt },
        matchId: authority.matchId, turnId: authority.turnId, phase: authority.phase, roomPhase: authority.roomPhase,
        drawerSeatId: authority.drawerSeatId, deadline: authority.deadline, paused: authority.paused, expiresAt: authority.expiresAt,
      };
    }
    const trusted = await context(snapshot);
    const view = project(snapshot, userKey, trusted);
    const game = snapshot.game;
    return {
      roomId, seatId: view.selfId, role: view.selfRole,
      view,
      roomRecord: { version: record.version, expiresAt: record.expiresAt },
      invitationGuard,
      roomGuard: { scope: 'rooms', id: roomId, expectedVersion: record.version },
      presenceGuard: { scope: 'room-presence', id: roomId,
        expectedVersion: trusted.presenceRecord?.version ?? null, validUntil: expiry(snapshot) },
      matchId: snapshot.matchId ?? null, turnId: game?.turnId ?? null,
      phase: game?.stage ?? snapshot.phase, roomPhase: snapshot.phase,
      drawerSeatId: game?.turnPlayerId ?? null,
      deadline: game?.stageClock?.deadlineAt ?? snapshot.turnClock?.deadlineAt ?? null,
      paused: snapshot.phase === 'paused', expiresAt: expiry(snapshot),
    };
  }
  // Read-only server contract for content GC. Even an expired waiting snapshot
  // remains protected until room sweep commits its tombstone. This never renews
  // a room or admits a player; the revision guard fences concurrent adoption.
  async function getContentReference({ packId, referenceId, version }) {
    const id = /^room-([a-f0-9]{32})$/.exec(referenceId ?? '')?.[1];
    if (!id) return null;
    const record = await storage.read('rooms', id), snapshot = record?.value.snapshot;
    const selection = snapshot?.drawConfig?.contentSelection;
    if (snapshot?.gameType !== 'draw-and-guess' || snapshot.phase !== 'waiting'
      || selection?.packId !== packId || selection.version !== version) return null;
    const deadline = expiry(snapshot);
    return { expiresAt: deadline > now() ? deadline : now() + ttlMs,
      guard: { scope: 'rooms', id, expectedVersion: record.version,
        ...(deadline > now() ? { validUntil: deadline } : {}) } };
  }
  async function action(code, userKey, input) {
    identity(userKey);
    requestId(input?.requestId);
    const leaveKey = hash(`${userKey}\0${input.requestId}`), fingerprint = hash(canonical(input));
    let attemptLimit = maxCasAttempts;
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      const invitation = await storage.read('room-invites', code);
      const original = invitation ? await storage.read('rooms', invitation.value.roomId) : null;
      const receipt = original?.value.leaveReceipts?.[leaveKey];
      if (receipt && now() < receipt.expiresAt) {
        if (receipt.fingerprint !== fingerprint) fail(409, 'REQUEST_ID_REUSED', '同一请求编号不能执行不同操作。');
        return copy(receipt.result);
      }
      const { roomId, record } = await resolvedRoom(code);
      attemptLimit = attemptsFor(record.value.snapshot);
      if (!['leave', 'transferHost'].includes(input.type) && record.value.snapshot.phase === 'playing' && record.value.snapshot.turnClock
          && now() >= record.value.snapshot.turnClock.deadlineAt) { await advanceExpiredTurn(roomId); continue; }
      engine(record.value.snapshot).getTrustedView(code, userKey);
      const prepared = await prepareAction(copy(record.value.snapshot), userKey, input, { expiresAt: now() + pausedTtlMs });
      const roomEngine = engine(record.value.snapshot, prepared);
      // A stable presence revision fences a reconnect racing an offline-host takeover.
      if (input.type === 'transferHost') await editPresence(roomId, () => {});
      const trustedContext = await context(record.value.snapshot);
      if (adapterFor(record.value.snapshot).usesPresenceLifecycle && record.value.snapshot.phase === 'playing'
          && !['leave', 'transferHost'].includes(input.type) && trustedContext.presence.seats.some(seat => !seat.connected)) {
        await reconcileLifecycle(roomId); continue;
      }
      roomEngine.getTrustedView(code, userKey, trustedContext);
      const actingSeatId = members(record.value.snapshot).find((player) => player.userKey === userKey).id;
      let result, error;
      try { result = roomEngine.trustedAction(code, userKey, input, trustedContext); }
      catch (failure) { if (!(failure instanceof RoomError)) throw failure; error = failure; }
      const snapshot = roomEngine.exportSnapshot(code);
      const leaveReceipts = Object.fromEntries(Object.entries(record.value.leaveReceipts ?? {}).filter(([, value]) => value.expiresAt > now()));
      if (result?.left) leaveReceipts[leaveKey] = { fingerprint, expiresAt: now() + leaveRetentionMs, result: { view: null, left: true } };
      const next = snapshot?.players.length
        ? { ...record.value, snapshot, leaveReceipts }
        : error ? terminalRecord(record.value, 'expired') : { snapshot: null, roomCode: code, deletedAt: now(), reason: 'empty', leaveReceipts,
          pendingRecords: [...(record.value.pendingRecords ?? []), ...(snapshot?.pendingRecords ?? [])] };
      const adapter = adapterFor(record.value.snapshot);
      const deadline = typeof adapter.actionDeadline === 'function'
        ? adapter.actionDeadline(record.value.snapshot, input)
        : record.value.snapshot.phase === 'playing' && record.value.snapshot.turnClock
          && !['leave', 'transferHost'].includes(input.type) ? record.value.snapshot.turnClock.deadlineAt : null;
      // A response prepared in time must also commit before its exact deadline.
      // Score changes and the durable room share this same guarded transaction.
      const guards = adapter.usesPresenceLifecycle ? presenceGuards(roomId, trustedContext) : input.type === 'transferHost' && trustedContext.presenceRecord
        ? [{ scope: 'room-presence', id: roomId, expectedVersion: trustedContext.presenceRecord.version,
          validUntil: expiry(record.value.snapshot) }] : [];
      let wrote;
      try { wrote = await commitRoom(roomId, record, next, { guards, validUntil: deadline ?? FOREVER }); }
      catch (failure) {
        if (failure.code !== 'GAME_HISTORY_CAPACITY' || !adapter.usesPresenceLifecycle) throw failure;
        await reconcileLifecycle(roomId, 'capacity', record.value.snapshot.matchId);
        throw failure;
      }
      if (wrote === false) continue;
      if (error) throw error;
      await publish(roomId);
      if (result.left) await cas('room-memberships', userKey, (previous) => {
        if (previous?.[roomId]?.playerId !== actingSeatId) return undefined;
        const next = { ...previous }; delete next[roomId]; return next;
      }).catch(() => {}); // A failed index cleanup cannot turn a committed departure into a failure.
      await flushPendingRecords().catch(() => {});
      return result.left ? result : { view: project(snapshot, userKey, await context(snapshot)), ...(result.guessResult ? { guessResult: result.guessResult } : {}) };
    }
    fail(503, 'STORE_BUSY', '房间正在同步，请稍后重试。');
  }
  async function editPresence(roomId, mutate) {
    return cas('room-presence', roomId, (previous) => {
      const next = presenceData(previous);
      const at = now(), previouslyOnline = new Set();
      for (const [playerId, connections] of Object.entries(next.connections)) {
        const leases = Object.values(connections);
        next.leaseExpiresAt[playerId] = Math.max(next.leaseExpiresAt[playerId] ?? 0, ...leases);
        if (leases.some(until => until > at)) previouslyOnline.add(playerId);
        for (const [connectionId, until] of Object.entries(connections)) if (until <= at) delete connections[connectionId];
        if (!Object.keys(connections).length) delete next.connections[playerId];
      }
      mutate(next.connections, next.lastSeen);
      for (const playerId of new Set([...Object.keys(next.leaseExpiresAt), ...Object.keys(next.connections)])) {
        const leases = Object.values(next.connections[playerId] ?? {});
        if (leases.some(until => until > at)) {
          next.leaseExpiresAt[playerId] = Math.max(...leases); delete next.absenceSinceAt[playerId];
        } else if (next.absenceSinceAt[playerId] === undefined) {
          next.absenceSinceAt[playerId] = previouslyOnline.has(playerId) ? at : Math.min(at, next.leaseExpiresAt[playerId]);
        }
      }
      return next;
    }, now() + Math.max(pausedTtlMs, ttlMs));
  }
  function end(listener, reason, status = 404) {
    if (!listener.active) return;
    listener.active = false;
    local.get(listener.roomId)?.delete(listener);
    try { listener.onEnd?.(reason, status); } catch { /* A failed transport cannot affect a room. */ }
  }
  async function publish(roomId) {
    const listeners = local.get(roomId);
    if (!listeners?.size) return;
    const record = await storage.read('rooms', roomId);
    if (!record?.value.snapshot || now() >= expiry(record.value.snapshot)) {
      for (const listener of [...listeners]) end(listener, '房间长时间没有活动，已回收。');
      return;
    }
    const trustedContext = await context(record.value.snapshot);
    if (closed || now() >= expiry(record.value.snapshot)) {
      for (const listener of [...listeners]) end(listener, closed ? '本机服务已停止。' : '房间长时间没有活动，已回收。');
      return;
    }
    // One immutable saved state owns this synchronous publication. Each member
    // still receives a newly projected private view, as in the in-memory room.
    // No engine or private projection is retained across publications.
    const projection = engine(record.value.snapshot);
    try {
      for (const listener of [...listeners]) {
        let view;
        try { view = projection.getTrustedView(record.value.snapshot.code, listener.userKey, trustedContext); }
        catch (error) {
          if (error instanceof RoomError && error.code === 'SEAT_REQUIRED') { end(listener, '你已离开房间。'); continue; }
          throw error;
        }
        const { serverTime, ...stableView } = view;
        const signature = JSON.stringify(stableView);
        if (!listener.active || signature === listener.signature) continue;
        listener.signature = signature;
        try { listener.onView(view); } catch { /* Isolate transport callbacks. */ }
      }
    } finally { projection.close(); }
  }
  async function cancelMatch(roomId, reason, initialMatchId = null) {
    let limit = maxCasAttempts;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const record = await storage.read('rooms', roomId), snapshot = record?.value.snapshot;
      if (!snapshot || snapshot.phase !== 'playing' || (initialMatchId && snapshot.matchId !== initialMatchId)) return false;
      const adapter = adapterFor(snapshot);
      if (!adapter.lifecycleTransition || reason === 'disconnected' && !adapter.disconnectTimeoutMs) return false;
      limit = attemptsFor(snapshot);
      const guards = [];
      if (reason === 'disconnected') {
        const presenceRecord = await storage.read('room-presence', roomId), value = presenceData(presenceRecord?.value);
        // Lease expiry is part of the 120 seconds, not a second grace period.
        const disconnected = snapshot.matchParticipants.some(({ playerId }) => {
          const connections = Object.values(value.connections[playerId] ?? {});
          if (connections.some(until => until > now())) return false;
          const lastSeen = Math.max(snapshot.matchStartedAt, value.lastSeen[playerId] ?? snapshot.matchStartedAt);
          return now() >= lastSeen + adapter.disconnectTimeoutMs;
        });
        if (!disconnected) return false;
        guards.push({ scope: 'room-presence', id: roomId, expectedVersion: presenceRecord?.version ?? null });
      }
      const roomEngine = engine(snapshot);
      if (!roomEngine.applyLifecycle(snapshot.code, { matchId: snapshot.matchId, reason })) return false;
      const next = { ...record.value, snapshot: roomEngine.exportSnapshot(snapshot.code) };
      if (!await commitRoom(roomId, record, next, { guards })) continue;
      await publish(roomId);
      await flushPendingRecords().catch(() => {});
      return true;
    }
    fail(503, 'STORE_BUSY', '房间正在同步，请稍后重试。');
  }
  async function cancelDisconnected(roomId) { return cancelMatch(roomId, 'disconnected'); }
  // Presence is read and guarded together with the game. Connection IDs remain
  // in the ephemeral presence scope; adapters receive only bounded seat evidence.
  async function reconcileLifecycle(roomId, reason = 'presence', initialMatchId = null) {
    let limit = maxCasAttempts, capacityApplied = false;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const record = await storage.read('rooms', roomId), snapshot = record?.value.snapshot;
      if (!snapshot || !['playing', 'paused'].includes(snapshot.phase)
          || initialMatchId && snapshot.matchId !== initialMatchId || !adapterFor(snapshot).usesPresenceLifecycle) return capacityApplied;
      limit = attemptsFor(snapshot);
      const trusted = await context(snapshot), roomEngine = engine(snapshot);
      if (!roomEngine.applyLifecycle(snapshot.code, { matchId: snapshot.matchId, reason, presence: trusted.presence })) return capacityApplied;
      const next = { ...record.value, snapshot: roomEngine.exportSnapshot(snapshot.code) };
      const guards = presenceGuards(roomId, trusted);
      let wrote;
      try { wrote = await commitRoom(roomId, record, next, { guards }); }
      catch (failure) {
        if (failure.code !== 'GAME_HISTORY_CAPACITY' || capacityApplied || ['capacity', 'capacity-cleared'].includes(reason)) throw failure;
        // Discard the unaffordable candidate. Suspend the persisted before-state
        // with the same trusted evidence, using only the reserved write budget.
        const capacityEngine = engine(snapshot);
        if (!capacityEngine.applyLifecycle(snapshot.code, { matchId: snapshot.matchId, reason: 'capacity', presence: trusted.presence })) throw failure;
        const held = { ...record.value, snapshot: capacityEngine.exportSnapshot(snapshot.code) };
        // A reserve failure is not retried recursively. CAS conflicts still use
        // the original bounded budget and re-read both room and presence.
        if (!await commitRoom(roomId, record, held, { guards })) continue;
        capacityApplied = true;
        await publish(roomId);
        await flushPendingRecords().catch(() => {});
        // One successful fallback gets one follow-up evaluation, even when the
        // CAS budget is one. Supplementary absence evidence must persist too.
        attempt -= 1;
        continue;
      }
      if (!wrote) continue;
      await publish(roomId);
      await flushPendingRecords().catch(() => {});
      return true;
    }
    fail(503, 'STORE_BUSY', '房间正在同步，请稍后重试。');
  }
  async function applyLifecycle(code, { matchId, reason } = {}) {
    if (reason !== 'capacity-cleared') fail(400, 'INVALID_LIFECYCLE', '系统生命周期原因无效。');
    if (typeof matchId !== 'string' || !/^[a-f0-9]{32}$/.test(matchId)) fail(400, 'INVALID_LIFECYCLE', '系统操作需要当前比赛编号。');
    const invitation = await storage.read('room-invites', code);
    if (!invitation || invitation.value.retired) return false;
    return reconcileLifecycle(invitation.value.roomId, reason, matchId);
  }
  async function recoverStartup() {
    // Freeze the startup inventory: a newly started match can never be mistaken
    // for one that was interrupted before this store booted.
    const interrupted = (await storage.scan('rooms')).map(record => record.value.snapshot)
      .filter(snapshot => snapshot && (['playing', 'paused'].includes(snapshot.phase) && adapterFor(snapshot).usesPresenceLifecycle
        || snapshot.phase === 'playing' && adapterFor(snapshot).recoverOnStartup))
      .map(snapshot => ({ roomId: snapshot.roomId, matchId: snapshot.matchId, presence: adapterFor(snapshot).usesPresenceLifecycle }));
    for (const { roomId, matchId, presence } of interrupted) {
      if (presence) await reconcileLifecycle(roomId, 'server-recovery', matchId);
      else await cancelMatch(roomId, 'server-recovery', matchId);
    }
  }
  async function advanceExpiredTurn(roomId) {
    let limit = maxCasAttempts;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await reconcileLifecycle(roomId);
      const record = await storage.read('rooms', roomId), snapshot = record?.value.snapshot, clock = snapshot?.turnClock;
      if (!clock || clock.deadlineAt === null || snapshot.phase !== 'playing' || now() < clock.deadlineAt || now() >= expiry(snapshot)) return false;
      limit = attemptsFor(snapshot);
      const trusted = adapterFor(snapshot).usesPresenceLifecycle ? await context(snapshot) : null;
      if (trusted && trusted.presence.seats.some(seat => !seat.connected)) continue;
      const roomEngine = engine(snapshot);
      if (!roomEngine.applyTurnTimeout(snapshot.code, clock)) return false;
      const next = { ...record.value, snapshot: roomEngine.exportSnapshot(snapshot.code) };
      let wrote;
      try { wrote = await commitRoom(roomId, record, next, { guards: trusted ? presenceGuards(roomId, trusted) : [] }); }
      catch (failure) {
        if (failure.code !== 'GAME_HISTORY_CAPACITY' || !trusted) throw failure;
        await reconcileLifecycle(roomId, 'capacity', snapshot.matchId); return false;
      }
      if (!wrote) continue;
      await publish(roomId);
      await flushPendingRecords().catch(() => {});
      return true;
    }
    fail(503, 'STORE_BUSY', '房间正在同步，请稍后重试。');
  }
  function poll() {
    if (pollingFlight) return pollingFlight;
    if (closed) return Promise.resolve();
    pollingFlight = (async () => {
      // The registry is bounded by maxRooms. This runs even when every browser is closed.
      const registry = (await storage.read('room-registry', 'active'))?.value ?? {};
      for (const [roomId, listeners] of local) {
        if (!listeners.size) { local.delete(roomId); continue; }
        await editPresence(roomId, (next, lastSeen) => {
          for (const listener of listeners) if (listener.active) {
            next[listener.playerId] ??= {};
            next[listener.playerId][listener.connectionId] = now() + presenceTtlMs;
            lastSeen[listener.playerId] = now();
          }
        });
        await publish(roomId);
      }
      for (const roomId of Object.keys(registry)) {
        const snapshot = (await storage.read('rooms', roomId))?.value.snapshot;
        if (snapshot && adapterFor(snapshot).usesPresenceLifecycle) await reconcileLifecycle(roomId);
        else await cancelDisconnected(roomId);
        await advanceExpiredTurn(roomId);
      }
    })().finally(() => { pollingFlight = null; });
    return pollingFlight;
  }
  async function subscribe(code, userKey, onView, onEnd) {
    identity(userKey);
    if (closed) fail(503, 'STORE_CLOSED', '服务正在重启，请稍后重试。');
    const { roomId, record } = await resolvedRoom(code);
    const view = project(record.value.snapshot, userKey);
    const listener = { roomId, userKey, playerId: view.selfId, connectionId: randomBytes(16).toString('hex'), onView, onEnd, active: true };
    await editPresence(roomId, (next, lastSeen) => {
      next[listener.playerId] ??= {};
      if (Object.keys(next[listener.playerId]).length >= 4) fail(429, 'CONNECTION_LIMIT', '这个席位连接过多，请关闭重复页面。');
      if(Object.values(next).reduce((count,connections)=>count+Object.keys(connections).length,0)>=16) fail(429,'ROOM_CONNECTION_LIMIT','房间连接已满，请关闭重复页面后重试。');
      next[listener.playerId][listener.connectionId] = now() + presenceTtlMs;
      lastSeen[listener.playerId] = now();
    });
    if (!local.has(roomId)) local.set(roomId, new Set());
    local.get(roomId).add(listener);
    try {
      await reconcileLifecycle(roomId);
      await publish(roomId);
    } catch (error) {
      end(listener, '房间暂时无法同步，请稍后重连。', 503);
      // The caller did not receive a disposer. Retire our listener even if the
      // backing store is unavailable; any unremoved lease then expires normally.
      await editPresence(roomId, next => { delete next[listener.playerId]?.[listener.connectionId]; }).catch(() => {});
      throw error;
    }
    return async () => {
      if (!listener.active) return;
      listener.active = false;
      local.get(roomId)?.delete(listener);
      await editPresence(roomId, (next, lastSeen) => { delete next[listener.playerId]?.[listener.connectionId]; lastSeen[listener.playerId] = now(); });
      await reconcileLifecycle(roomId);
      await publish(roomId);
    };
  }
  async function sweep() {
    await poll();
    await cas('room-registry', 'active', async (previous) => {
      const entries = { ...(previous ?? {}) };
      for (const [roomId, entry] of Object.entries(entries)) {
        const record = await storage.read('rooms', roomId);
        if (await collectExpired(roomId, record, entry.reservedAt)) delete entries[roomId];
      }
      return entries;
    });
    await flushPendingRecords().catch(() => {});
    let legacyIdentities;
    async function tombstoneIdentity(record) {
      if (record.value.roomCode) {
        const invitation = await storage.read('room-invites', record.value.roomCode);
        return invitation ? { roomId: invitation.value.roomId, code: record.value.roomCode, invitation } : null;
      }
      // Pre-lifecycle terminal rows lacked their identity. Old create markers normally retain the code;
      // invitation values recover the room id even after the registry has dropped the room.
      if (!legacyIdentities) {
        legacyIdentities = new Map(); const codes = new Map();
        for (const operation of await storage.scan('room-requests')) if (/^[a-f0-9]{32}$/.test(operation.value.roomId ?? '') && /^\d{6}$/.test(operation.value.code ?? '')) codes.set(operation.value.roomId, operation.value.code);
        const ids = new Set(codes.keys());
        for (const invitation of await storage.scan('room-invites')) if (/^[a-f0-9]{32}$/.test(invitation.value.roomId ?? '')) ids.add(invitation.value.roomId);
        for (const roomId of ids) {
          const saved = await storage.read('rooms', roomId);
          if (saved && !saved.value.snapshot) legacyIdentities.set(saved.version, { roomId, code: codes.get(roomId) });
        }
      }
      const found = legacyIdentities.get(record.version);
      if (!found) return null;
      return { ...found, ...(found.code ? { invitation: await storage.read('room-invites', found.code) } : {}) };
    }
    for (const record of await storage.scan('rooms')) {
      const expired = Object.values(record.value.leaveReceipts ?? {}).every((receipt) => receipt.expiresAt <= now());
      if (!record.value.snapshot && !(record.value.pendingRecords ?? []).length && expired && now() >= record.value.deletedAt + leaveRetentionMs) {
        // Only the invitation's non-personal retired marker remains; old links cannot target a later room.
        const found = await tombstoneIdentity(record);
        if (!found) continue;
        const { roomId, code, invitation } = found;
        if (code && (!invitation || invitation.value.roomId !== roomId)) continue;
        if (invitation && !invitation.value.retired && !(await storage.replaceCAS('room-invites', code, invitation.version,
          { roomId, retired: true }, FOREVER))) continue;
        // A legacy invitation with no surviving create marker cannot resurrect this id and remains non-reusable.
        await storage.remove('rooms', roomId, record.version);
      }
    }
  }
  function setHistory(value) { if (!value?.archive) throw new TypeError('Match history requires archive(summary).'); history = value; }
  async function flushPendingRecords() {
    if (!history || historyFlight) return historyFlight;
    historyFlight = (async () => {
      for (const record of await storage.scan('rooms')) {
        const pending = [...(record.value.pendingRecords ?? []), ...(record.value.snapshot?.pendingRecords ?? [])];
        if (!pending.length) continue;
        const roomId = record.value.snapshot?.roomId ?? pending[0].roomId;
        for (const summary of pending) {
          await history.archive(copy(summary));
          await cas('rooms', roomId, (previous) => {
            if (!previous) return undefined;
            const next = copy(previous);
            next.pendingRecords = (next.pendingRecords ?? []).filter((entry) => entry.matchId !== summary.matchId);
            if (next.snapshot) next.snapshot.pendingRecords = (next.snapshot.pendingRecords ?? []).filter((entry) => entry.matchId !== summary.matchId);
            return next;
          });
        }
      }
    })();
    try { await historyFlight; } finally { historyFlight = null; }
  }
  const timer = pollIntervalMs > 0 ? setInterval(() => {
    ready.then(poll).catch(() => {
      // A storage outage closes streams; it never serves a stale cached private view.
      for (const listeners of local.values()) for (const listener of [...listeners]) end(listener, '房间暂时无法同步，请稍后重连。', 503);
    });
  }, pollIntervalMs) : null;
  timer?.unref();
  async function close() {
    closed = true;
    authorityMetadata.clear();
    if (timer) clearInterval(timer);
    await ready.catch(() => {});
    if (pollingFlight) await pollingFlight.catch(() => {});
    for (const [roomId, listeners] of local) {
      const closing = [...listeners];
      for (const listener of closing) end(listener, '服务已停止，请稍后重连。');
      await editPresence(roomId, (next) => {
        for (const listener of closing) delete next[listener.playerId]?.[listener.connectionId];
      });
      await reconcileLifecycle(roomId);
    }
    local.clear();
  }
  const ready = recoverStartup();
  ready.catch(() => {}); // Public methods still reject; this only prevents an unhandled boot promise.
  const afterReady = fn => async (...args) => { await ready; return fn(...args); };
  return { ready, ...Object.fromEntries(Object.entries({ ensureProfile, setProfile, recentRooms, createRoom, joinRoom,
    getView, getChatMember, getGameContext, getContentReference, action, subscribe, sweep, flushPendingRecords, applyLifecycle })
    .map(([name, fn]) => [name, afterReady(fn)])), close, setHistory };
}
