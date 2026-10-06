import { EncryptedStore, MemoryAdapter, SQLiteAdapter } from './storage.mjs';
import { SessionService } from './session-service.mjs';
import { createDurableRoomStore } from './durable-rooms.mjs';
import { createRoomChat } from './chat.mjs';
import { createRoomPreview } from './room-preview.mjs';
export function createRuntime(settings, options = {}) {
  const storage = options.storage || new EncryptedStore(settings.storePath ? new SQLiteAdapter(settings.storePath) : new MemoryAdapter(), settings.storeKey);
  const sessions = options.sessions || new SessionService(settings, {store:storage, provider:options.provider, now:options.now});
  const rooms = options.rooms || createDurableRoomStore({storage, now:options.now, ...options.roomOptions});
  const chat = options.chat || createRoomChat({storage, rooms, now:options.now, ...options.chatOptions});
  const preview = options.preview || createRoomPreview({now:options.now,...options.previewOptions});
  return {settings,storage,sessions,rooms,chat,preview};
}
