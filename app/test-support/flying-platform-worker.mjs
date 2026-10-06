// A fresh process for synthetic persistence tests. Never reads production settings.
import { EncryptedStore, SQLiteAdapter } from '../../server/storage.mjs';
import { createDurableRoomStore } from '../../server/durable-rooms.mjs';
import { createMatchHistory } from '../../server/match-history.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { storePath, keyHex, at, code, userKey, roomId } = JSON.parse(input);
const now = () => at;
const storage = new EncryptedStore(new SQLiteAdapter(storePath, { now }), Buffer.from(keyHex, 'hex'), now);
const rooms = createDurableRoomStore({ storage, now, pollIntervalMs: 0,
  serverRandomInt: () => { throw new Error('Restoring a committed game must not sample randomness'); } });
const history = createMatchHistory({ storage, now });
rooms.setHistory(history);
try {
  const view = await rooms.getView(code, userKey);
  const snapshot = (await storage.read('rooms', roomId)).value.snapshot;
  const recent = await rooms.recentRooms(userKey);
  const records = await history.get(userKey);
  process.stdout.write(JSON.stringify({ view, snapshot, recent, records }));
} finally {
  await rooms.close();
  storage.close();
}
