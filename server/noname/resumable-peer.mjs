import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

export const resumeProtocol = 'sumomo-noname-v2';
const maxFrames = 2048, maxBytes = 8 * 1024 * 1024;
const sameTerminal = (a, b) => a.sessionId === b.sessionId && a.playerId === b.playerId && a.clientId === b.clientId;

// The upstream relay still owns one connection per player. A transport break
// retains that connection and its unacknowledged frames, including the host's.
export function createResumablePeers({ graceMs = 10 * 60_000, leaveSeat, hasOtherTerminal = () => false } = {}) {
  const sessions = new Map();
  const superseded = new Map();

  function open(claim) {
    const key = randomBytes(32).toString('base64url');
    const peer = new EventEmitter();
    let wire, expiry, heartbeat, lastIn = 0, lastOut = 0, acknowledged = 0, bytes = 0;
    const pending = new Map();
    function stop(code = 1000) {
      if (!sessions.delete(key)) return;
      clearTimeout(expiry);
      clearInterval(heartbeat);
      pending.clear();
      if (wire?.readyState === 1) wire.close(code);
      wire = null;
      peer.emit('close');
    }
    function ack(n) {
      if (!Number.isSafeInteger(n) || n < acknowledged || n > lastOut) return false;
      while (acknowledged < n) {
        const packet = pending.get(++acknowledged);
        bytes -= Buffer.byteLength(packet);
        pending.delete(acknowledged);
      }
      return true;
    }
    function send(packet) {
      if (wire?.readyState === 1) wire.send(JSON.stringify(packet));
    }
    peer.send = text => {
      if (!sessions.has(key)) return;
      // The upstream heartbeat checks the logical peer. A disconnected phone
      // is timed by the grace timer. The wire has its own foreground probe.
      if (text === 'heartbeat') { peer.emit('message', 'heartbeat'); return; }
      bytes += Buffer.byteLength(text);
      if (bytes > maxBytes || pending.size >= maxFrames) return stop();
      pending.set(++lastOut, text);
      send(['data', lastOut, text]);
    };
    peer.close = stop;
    peer.revokeSession = stop;
    peer.transportOnline = () => wire?.readyState === 1;
    peer.supersede = () => {
      if (superseded.size >= 1600) superseded.delete(superseded.keys().next().value);
      superseded.set(key, {claim, until:Date.now()+graceMs});
      stop(4009);
    };
    function attach(socket, cursor) {
      if (!ack(cursor)) { socket.close(1008); return false; }
      clearTimeout(expiry);
      clearInterval(heartbeat);
      const old = wire;
      wire = socket;
      old?.close(1000);
      peer.emit('transport');
      let alive = true;
      socket.on('pong', () => { alive = true; });
      heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, 30_000);
      heartbeat.unref();
      send(['ready', key, lastIn, leaveSeat ? 'explicit-leave' : null]);
      for (const [seq, value] of pending) send(['data', seq, value]);
      socket.on('message', raw => {
        if (socket !== wire) return;
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return socket.close(1008); }
        if (!Array.isArray(msg)) return socket.close(1008);
        const [type, seq, value] = msg;
        if (type === 'leaveTable' && leaveSeat) {
          Promise.resolve(leaveSeat(peer)).then(accepted => {
            if (socket !== wire) return;
            send(['left', Boolean(accepted)]);
            if (accepted) stop();
          }).catch(() => { if (socket === wire) send(['left', false]); });
          return;
        }
        if (type === 'leave') return stop();
        if (type === 'ping') return send(['pong']);
        if (type === 'ack' && ack(seq)) return;
        if (type !== 'data' || !Number.isSafeInteger(seq) || seq < 1 || seq > lastIn + 1 || typeof value !== 'string') {
          return socket.close(1008);
        }
        if (seq === lastIn + 1) {
          lastIn = seq;
          peer.emit('message', value);
        }
        send(['ack', lastIn]);
      });
      socket.once('close', code => {
        if (socket !== wire) return;
        clearInterval(heartbeat);
        wire = null;
        if (code === 4000) return stop();
        peer.emit('transport');
        expiry = setTimeout(stop, graceMs);
        expiry.unref();
      });
      return true;
    }
    const session = { claim, peer, attach, stop };
    sessions.set(key, session);
    return session;
  }

  function accept(socket, claim, connected) {
    const timeout = setTimeout(() => socket.close(1008), 8000);
    timeout.unref();
    socket.once('close', () => clearTimeout(timeout));
    socket.once('message', raw => {
      clearTimeout(timeout);
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return socket.close(1008); }
      if (!Array.isArray(msg) || msg.length !== 3 || msg[0] !== 'hello') return socket.close(1008);
      const [, key, cursor] = msg;
      if (key === null && cursor === 0 && sessions.size < 1600) {
        const session = open(claim);
        session.attach(socket, 0);
        connected(session.peer);
        return;
      }
      const session = typeof key === 'string' && sessions.get(key);
      if (!session || !sameTerminal(session.claim, claim) || session.claim.expiresAt <= Date.now()) {
        const previous = superseded.get(key);
        if (previous && previous.until <= Date.now()) superseded.delete(key);
        if ((previous?.until > Date.now() && sameTerminal(previous.claim,claim)) || hasOtherTerminal(claim)) {
          socket.close(4009, 'Seat opened elsewhere');
        } else socket.close(4004, 'Session ended');
        return;
      }
      session.attach(socket, cursor);
    });
  }
  return { accept, close() { superseded.clear(); for (const session of sessions.values()) session.stop(); } };
}
