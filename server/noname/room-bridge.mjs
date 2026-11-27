import { randomBytes } from 'node:crypto';
import { bindManagedTables } from './managed-tables.mjs';

const platformId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const nativeSeat = value => typeof value === 'string' && /^\d{10}$/.test(value);
const guestCommands = new Set(['init']);
const hostCommands = new Set(['init', 'reinit', 'denied']);

function handshake(raw, commands) {
  if (typeof raw !== 'string') return null;
  // The native client always serializes the verb first. Leave unrelated gameplay
  // and its private payload opaque, including large state updates and extensions.
  const verb = /^\["([a-zA-Z_][a-zA-Z0-9_]*)"(?:,|\])/.exec(raw);
  if (verb && !commands.has(verb[1])) return null;
  try {
    const frame = JSON.parse(raw);
    return Array.isArray(frame) && commands.has(frame[0]) ? frame : null;
  } catch { return null; }
}

// The shell authenticates the platform session. The original relay owns the socket and
// room objects. Neither a URL parameter nor a browser-supplied room key grants voice.
export function createNonameRoomBridge({
  now = Date.now, ticketTtlMs = 30_000, retention = null, openEngine,
  onListenerError = error => process.emitWarning(error),
} = {}) {
  if (!Number.isInteger(ticketTtlMs) || ticketTtlMs < 1 || ticketTtlMs > 60_000) {
    throw new RangeError('Expected a ticket lifetime of at most 60 seconds.');
  }
  const tickets = new Map();
  const peers = new Map();
  const tables = new Map();
  const admitting = new Set();
  const bySession = new Map();
  const byPlayer = new Map();
  const listeners = new Set();
  let closed = false, draining = false, managed;

  function emit(current, previous) {
    for (const callback of listeners) {
      try { callback(current, previous); } catch (error) { onListenerError(error); }
    }
  }

  function unseat(peer) {
    const previous = peer.member;
    if (!previous) return;
    peer.member = null;
    if (bySession.get(previous.sessionId) === peer) bySession.delete(previous.sessionId);
    if (byPlayer.get(previous.playerId) === peer) byPlayer.delete(previous.playerId);
    emit(null, previous);
  }

  function forgetSeat(peer) {
    if (peer.table?.seats.get(peer.seat)?.socket === peer.socket) peer.table.seats.delete(peer.seat);
  }

  function disable(peer) {
    peer.disabled = true;
    unseat(peer);
  }

  function available(peer) {
    if (!peer || peer.disabled || closed) return false;
    if (peer.expiresAt > now()) return true;
    disable(peer);
    return false;
  }

  function seat(peer, table) {
    if (!available(peer) || !table?.open || peer.member) return;
    const previous = byPlayer.get(peer.playerId);
    if (table.room.managed && previous?.member && previous === bySession.get(peer.sessionId) &&
        previous.table === table && previous.seat === peer.seat && previous.clientId === peer.clientId && available(previous)) {
      // The rules confirmed the same seat in the same signed-in window. Move
      // its membership atomically so voice doesn't interpret a new game socket as a departure.
      peer.member = previous.member;
      previous.member = null;
      disable(previous);
    } else {
      for (const other of [bySession.get(peer.sessionId), previous]) {
        if (other && other !== peer) disable(other);
      }
      peer.member = Object.freeze({
        roomId: table.id, playerId: peer.playerId, sessionId: peer.sessionId,
        clientId: peer.clientId, gameType: 'noname',
      });
    }
    bySession.set(peer.sessionId, peer);
    byPlayer.set(peer.playerId, peer);
    emit(peer.member, null);
  }

  function dropTable(table) {
    if (!table?.open) return;
    table.open = false;
    tables.delete(table.room);
    for (const peer of table.peers) disable(peer);
    table.peers.clear();
    table.seats.clear();
  }

  function detach(socket) {
    managed?.disconnected(socket);
    const peer = peers.get(socket);
    if (!peer) return;
    peers.delete(socket);
    clearTimeout(peer.expiryTimer);
    if (peer.table?.owner === socket) dropTable(peer.table);
    else if (!peer.table?.room.config?.gameStarted) forgetSeat(peer);
    else if (peer.table.seats.get(peer.seat)?.socket === socket) peer.table.seats.get(peer.seat).socket = null;
    peer.table?.peers.delete(peer);
    disable(peer);
  }

  function scheduleExpiry(peer) {
    const delay = peer.expiresAt - now();
    if (delay <= 0) {
      disable(peer);
      peer.socket.revokeSession?.();
      return;
    }
    // Very long sessions must not overflow Node's 32-bit timer delay.
    peer.expiryTimer = setTimeout(() => scheduleExpiry(peer), Math.min(delay, 2_147_483_647));
    peer.expiryTimer.unref();
  }

  return {
    managed:Boolean(openEngine),
    bindManaged(native) {
      if (!openEngine) return null;
      if (!retention) throw new Error('A retained game engine requires durable seats');
      managed = bindManagedTables({...native, bridge:this, retention, openEngine});
      return managed;
    },
    identity(socket) {
      const peer = peers.get(socket);
      return available(peer) ? {player:peer.playerId, binding:peer.binding} : null;
    },
    seatManaged(socket, room, id, nativeId) {
      const peer = peers.get(socket);
      if (!available(peer)) return;
      let table = tables.get(room);
      if (!table) {
        table = {id, owner:room.owner, room, open:true, peers:new Set(), seats:new Map()};
        tables.set(room, table);
      }
      peer.table = table;
      peer.seat = nativeId;
      table.peers.add(peer);
      table.seats.set(nativeId, {playerId:peer.playerId, socket});
      seat(peer, table);
    },
    closeManaged(room) { dropTable(tables.get(room)); },
    notifySavedTable(players, table) {
      const affected = new Set(players);
      const message = JSON.stringify(['sumomoMyTable',table]);
      for (const peer of peers.values()) {
        if (affected.has(peer.playerId) && available(peer)) peer.socket.send(message);
      }
    },
    restoreManaged() { return managed?.restore(); },
    transportChanged(socket) { managed?.transportChanged(socket); },
    canCreate() { return !closed && !draining; },
    control(op) {
      if (op === 'drain') draining = true;
      else if (op === 'resume') draining = false;
      else if (op !== 'status') throw new TypeError('Unknown Noname admission operation');
      return { draining: closed || draining, openTables: tables.size };
    },
    async protection() {
      const unfinishedTables = retention ? await retention.unfinished() : null;
      return {draining:closed || draining, openTables:tables.size, unfinishedTables,
        pendingAdmissions:admitting.size + (managed?.pending() ?? 0)};
    },
    issue(sessionId, playerId, clientId, { expiresAt = Infinity } = {}) {
      if (closed || ![sessionId, playerId, clientId].every(platformId)
          || !(expiresAt === Infinity || Number.isSafeInteger(expiresAt)) || expiresAt <= now()) {
        throw new TypeError('A current platform session, player and terminal are required.');
      }
      const time = now();
      for (const [ticket, claim] of tickets) {
        if (claim.until <= time) tickets.delete(ticket);
      }
      if (tickets.size >= 4096) throw new Error('Noname relay ticket capacity reached.');
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { sessionId, playerId, clientId, expiresAt, until: Math.min(time + ticketTtlMs, expiresAt) });
      return ticket;
    },
    consume(ticket) {
      const claim = tickets.get(ticket);
      tickets.delete(ticket);
      return !closed && claim?.until > now() ? claim : null;
    },
    attach(socket, claim) {
      if (closed || !claim || claim.expiresAt <= now()) return false;
      const peer = { ...claim, socket, binding:randomBytes(16).toString('hex'), member: null, table: null, seat: null, requestedSeat: null, disabled: false };
      peers.set(socket, peer);
      if (Number.isFinite(peer.expiresAt)) scheduleExpiry(peer);
      return true;
    },
    async created(owner, room) {
      const peer = peers.get(owner);
      if (!available(peer) || draining || room.owner !== owner || peer.table ||
          peer.admitting || admitting.has(room.key)) return false;
      peer.admitting = true;
      admitting.add(room.key);
      try {
        const id = retention ? await retention.begin(room.key, peer.playerId, peer.binding, owner.wsid) : randomBytes(16).toString('hex');
        if (!id || peers.get(owner) !== peer || !available(peer)) return false;
        const table = {id, owner, room, open:true, peers:new Set([peer]), seats:new Map()};
        tables.set(room, table);
        peer.table = table;
        seat(peer, table);
        return true;
      } finally {
        peer.admitting = false;
        admitting.delete(room.key);
      }
    },
    async completed(owner) {
      const peer = peers.get(owner), table = peer?.table;
      if (!retention || !available(peer) || table?.owner !== owner || !table.open || table.room.config?.gameStarted !== true) return false;
      return retention.phase(table.room.key, table.id, 'finished');
    },
    async started(owner) {
      const peer = peers.get(owner), table = peer?.table;
      if (!retention || !available(peer) || table?.owner !== owner || !table.open) return;
      await retention.phase(table.room.key, table.id, 'playing');
    },
    savedSeat(playerId) { return retention?.forPlayer(playerId) ?? null; },
    hasOtherTerminal(claim) {
      const current = byPlayer.get(claim.playerId);
      return available(current) && (current.sessionId !== claim.sessionId || current.clientId !== claim.clientId);
    },
    async leaveSeat(socket) {
      const peer = peers.get(socket);
      if (!available(peer)) return false;
      if (managed && socket.room?.managed) {
        if (!await managed.leave(socket)) return false;
      } else if (!peer.member) return true;
      else if (retention && peer.table) {
        const result = await retention.leave(peer.table.room.key, peer.table.id, peer.playerId, peer.binding);
        if (!result) return false;
      }
      forgetSeat(peer);
      unseat(peer);
      return true;
    },
    mayReconnect(socket, room) {
      const peer = peers.get(socket), table = tables.get(room);
      return Boolean(available(peer) && table?.open && [...table.seats.values()].some(s => s.playerId === peer.playerId));
    },
    entered(socket, room) {
      const peer = peers.get(socket), table = tables.get(room);
      if (!peer || !table?.open) return;
      peer.table = table;
      table.peers.add(peer);
    },
    guestMessage(socket, raw) {
      // "opened" causes the native client to send this handshake. Normal game messages
      // stay opaque. Never forward another account's remembered native seat to the host.
      const args = handshake(raw, guestCommands);
      if (!args) return raw;
      const peer = peers.get(socket);
      if (!peer?.table?.open || peer.member || !args[2] || typeof args[2] !== 'object') return null;
      const id = args[2].id;
      peer.requestedSeat = nativeSeat(id) ? id : null;
      const seat = peer.table.seats.get(peer.requestedSeat);
      if (peer.table.room.config?.gameStarted && (!seat || seat.playerId !== peer.playerId)) {
        const owned = [...peer.table.seats].filter(([,saved]) => saved.playerId === peer.playerId);
        if (owned.length > 1) return null;
        if (owned.length === 1) {
          peer.requestedSeat = owned[0][0];
          args[2].id = peer.requestedSeat;
          return JSON.stringify(args);
        }
      }
      if (seat && seat.playerId !== peer.playerId) return null;
      if (id != null && !seat) {
        // A browser can retain an old id across games. Let the owner treat it as
        // a fresh join; only a seat previously attributed to this account can resume.
        args[2].id = null;
        return JSON.stringify(args);
      }
      return raw;
    },
    async hostMessage(host, socket, raw) {
      // Only the native relay's authenticated room owner can reach this hook.
      const args = handshake(raw, hostCommands);
      if (!args) return true;
      const peer = peers.get(socket), table = peer?.table;
      if (table?.owner !== host || !table.open) return false;
      if (args[0] === 'denied') {
        forgetSeat(peer);
        disable(peer);
        return true;
      }
      if (args[0] === 'reinit' && args.length >= 6 && args[5] !== null) {
        if (peer.requestedSeat && table.seats.get(peer.requestedSeat)?.playerId === peer.playerId) return false;
        // Upstream supplies the observed player's id for spectators. Spectating is
        // still native gameplay and has no right to hear or publish table audio.
        disable(peer);
        return true;
      }
      if (args[0] === 'reinit') {
        if (args.length < 6 || !peer.requestedSeat || table.seats.get(peer.requestedSeat)?.playerId !== peer.playerId) return false;
        peer.seat = peer.requestedSeat;
        socket.send(JSON.stringify(['sumomoSeat',peer.seat]));
      } else {
        // NodeWS.id for an initial admission is the relay's own socket id.
        if (!nativeSeat(args[1]) || args[1] !== socket.wsid || args[4] !== false) return false;
        peer.seat = args[1];
      }
      if (retention && !await retention.takeSeat(table.room.key, table.id, peer.playerId, peer.seat, peer.binding)) return false;
      if (available(peer)) table.seats.set(peer.seat, { playerId: peer.playerId, socket });
      seat(peer, table);
      return true;
    },
    kicked(socket) {
      const peer = peers.get(socket);
      if (peer) {
        forgetSeat(peer);
        disable(peer);
      }
    },
    detach,
    membership(sessionId, clientId) {
      const peer = bySession.get(sessionId);
      if (!available(peer) || (clientId !== undefined && peer.clientId !== clientId)) return null;
      return peer.member;
    },
    subscribe(listener) {
      if (closed || typeof listener !== 'function') throw new TypeError('Expected an active membership listener.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revokeSession(sessionId) {
      for (const [ticket, claim] of tickets) if (claim.sessionId === sessionId) tickets.delete(ticket);
      for (const peer of peers.values()) if (peer.sessionId === sessionId) {
        disable(peer);
        peer.socket.revokeSession?.();
      }
    },
    close() {
      closed = true;
      tickets.clear();
      for (const socket of peers.keys()) detach(socket);
      listeners.clear();
      return managed?.close();
    },
  };
}
