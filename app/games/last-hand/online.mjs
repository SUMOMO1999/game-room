import { unique, getObj, saveObj } from './widgets.mjs';
import { request, watchSeat } from './room-bridge.mjs';
export { request };
export function connectRoom(first, onView, onConnection, onChat) {
  let room = first,
    closed = false,
    source = null,
    recovery = null;
  const path = '/' + first.roomCode,
    slot = 'olh:pending:' + first.roomCode + ':' + first.selfId;
  const accept = (v) => {
    if (!closed && v?.roomCode === first.roomCode && v.revision >= room.revision) {
      room = v;
      onView(v);
    }
  };
  async function sync() {
    if (closed) return;
    try {
      accept(await request(path));
      if (!closed) onConnection(true);
    } catch {
      if (!closed) onConnection(false);
    }
  }
  async function reconnect() {
    await sync();
    if (!closed) await recover()?.catch(() => onConnection(false));
  }
  async function post(a) {
    const result = await request(path + '/act', a);
    if (result.view) accept(result.view);
    return result;
  }
  function clearPending(id) {
    if (getObj(slot)?.requestId === id) saveObj(slot, null);
  }
  async function retryPending(queued) {
    if (
      queued.matchId !== room.matchId ||
      room.actionReceipts?.some((x) => x.requestId === queued.requestId) ||
      queued.seatRevision !== room.game?.own?.revision
    ) {
      clearPending(queued.requestId);
      return;
    }
    try {
      await post(queued);
      clearPending(queued.requestId);
    } catch (e) {
      if (e.status && e.status < 500) {
        clearPending(queued.requestId);
        await sync();
      } else throw e;
    }
  }
  function recover() {
    if (recovery) return recovery;
    const queued = getObj(slot);
    if (!queued) return null;
    recovery = retryPending(queued).finally(() => {
      recovery = null;
    });
    return recovery;
  }
  async function setReady(ready) {
    // Other seats may ready up together. Retry only a rejected revision and
    // only while this seat is still deciding under the same table options.
    const options = JSON.stringify(room.tableOptions);
    const match = room.matchId;
    const seats = room.tableOptions.seats;
    for (let attempt = 0; ; attempt++) {
      const expectedRevision = room.revision;
      try {
        return await post({ type: 'ready', ready, expectedRevision, requestId: unique() });
      } catch (e) {
        await sync();
        const self = room.players.find((p) => p.id === first.selfId);
        if (e.code !== 'REVISION_CONFLICT' || closed || !self || room.phase !== 'waiting' ||
            room.matchId !== match || JSON.stringify(room.tableOptions) !== options) throw e;
        if (self.ready === ready) return;
        if (room.revision <= expectedRevision || attempt >= seats) throw e;
      }
    }
  }
  async function action(type, values = {}) {
    if (type === 'ready') return setReady(values.ready);
    if (type === 'tableMove' && (getObj(slot) || recovery)) {
      await recover();
      return;
    }
    const a = { type, expectedRevision: room.revision, requestId: unique(), ...values };
    if (type === 'tableMove') {
      a.matchId = room.matchId;
      a.seatRevision = room.game.own.revision;
      saveObj(slot, a);
    }
    try {
      const r = await post(a);
      if (type === 'tableMove') clearPending(a.requestId);
      return r;
    } catch (e) {
      if (type === 'tableMove' && e.status && e.status < 500) clearPending(a.requestId);
      await sync();
      throw e;
    }
  }
  window.addEventListener('online', reconnect);
  source = watchSeat(first, accept, onConnection, () => recover()?.catch(() => onConnection(false)), onChat);
  reconnect();
  return {
    action,
    sync,
    async chatHistory(query) {
      if (!source) throw Error('正在恢复房间连接');
      return source.client.chatHistory(query);
    },
    async sendChat(message) {
      if (!source) throw Error('正在恢复房间连接');
      return source.client.sendChat(message);
    },
    close() {
      closed = true;
      source?.close();
      window.removeEventListener('online', reconnect);
    },
  };
}
