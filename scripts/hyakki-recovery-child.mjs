// S1 destructive-process fixture. Uses only a caller-owned synthetic SQLite path.
import { readFileSync } from 'node:fs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { createDurableRoomStore } from '../server/durable-rooms.mjs';
import { createGameRegistry } from '../app/game-registry.mjs';
import { createHyakkiContractAdapter, createHyakkiContractPreparers } from '../app/games/hyakki-trading/test-support/contract-adapter.mjs';
const [mode, path, keyPath, at, roomCode] = process.argv.slice(2), now = () => Number(at);
const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), readFileSync(keyPath), now);
const gameRegistry = createGameRegistry([createHyakkiContractAdapter()]);
const rooms = createDurableRoomStore({ storage, now, gameRegistry, pollIntervalMs: 0, presenceTtlMs: 1000,
  transitionPreparers: createHyakkiContractPreparers(storage, { now }) });
const users = ['a'.repeat(64), 'b'.repeat(64)];
let sequence = 0;
try {
  await rooms.ready;
  if (mode === 'create') {
    const host = await rooms.createRoom(users[0], '甲', 'crash-create', 'hyakki-trading');
    await rooms.joinRoom(host.roomCode, users[1], '乙', 'crash-join');
    for (const user of users) await rooms.subscribe(host.roomCode, user, () => {});
    const act = async (index, type, extra = {}) => rooms.action(host.roomCode, users[index], { type,
      requestId: `crash-action-${++sequence}`, expectedRevision: (await rooms.getView(host.roomCode, users[index])).revision, ...extra });
    await act(0, 'ready', { ready: true }); await act(1, 'ready', { ready: true }); await act(0, 'start');
    await act(0, 'probe-response');
    const snapshot = (await storage.read('rooms', host.view.roomId)).value.snapshot;
    process.send({ roomCode: host.roomCode, roomId: host.view.roomId, snapshot });
    setInterval(() => {}, 1000); // Parent SIGKILL proves no graceful-close checkpoint was involved.
  } else if (mode === 'recover') {
    const view = await rooms.getView(roomCode, users[0]);
    const snapshot = (await storage.read('rooms', view.roomId)).value.snapshot;
    process.send({ snapshot, sessions: (await storage.scan('sessions')).length, presence: (await storage.scan('room-presence')).length });
    await rooms.close(); storage.close(); process.disconnect();
  } else throw new Error('Unknown recovery test mode');
} catch (error) {
  process.send?.({ error: error.stack }); storage.close(); process.disconnect?.(); process.exitCode = 1;
}
