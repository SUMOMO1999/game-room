import { EncryptedStore, MemoryAdapter, SQLiteAdapter } from './storage.mjs';
import { SessionService } from './session-service.mjs';
import { createDurableRoomStore } from './durable-rooms.mjs';
import { createRoomChat } from './chat.mjs';
import { createRoomPreview } from './room-preview.mjs';
import { createDrawAndGuessWordbank } from './content/draw-and-guess-wordbank.mjs';
import { createDrawingContentAssembly } from './games/draw-and-guess/content-assembly.mjs';
import { createCanvasService } from './games/draw-and-guess/canvas-service.mjs';
import { createIdentityBatchRuntime } from './identity-batch-runtime.mjs';
import { createGameScores } from './game-scores.mjs';
import { defaultGameRegistry } from '../app/game-registry.mjs';
export function createRuntime(settings, options = {}) {
  const identityRuntime = options.sessions || options.provider ? null
    : createIdentityBatchRuntime(settings, { now: options.now, env: options.identityEnv });
  let storage, sessions;
  try {
    storage = options.storage || new EncryptedStore(settings.storePath ? new SQLiteAdapter(settings.storePath) : new MemoryAdapter(), settings.storeKey);
    sessions = options.sessions || new SessionService(settings, {store:storage, provider:options.provider || identityRuntime?.provider, now:options.now});
  } catch(error) {
    identityRuntime?.close().catch(()=>{});
    if(!options.storage) storage?.close();
    throw error;
  }
  const drawingEnabled = options.drawingEnabled ?? settings.drawingEnabled ?? false;
  const gameRegistry = options.roomOptions?.gameRegistry ?? defaultGameRegistry;
  const poker414Enabled = !options.rooms && gameRegistry.creationTypes().includes('poker414-2');
  const scores = options.scores || createGameScores({ storage, now: options.now });
  let rooms;
  const wordbanks = options.wordbanks || createDrawAndGuessWordbank({ storage, now: options.now,
    protectedReference: reference => rooms?.getContentReference(reference) ?? null });
  const wordbankReady = drawingEnabled ? wordbanks.ensureSeed({ publishInitial: true }) : Promise.resolve();
  // Keep the promise rejected for requests, but prevent a transient startup
  // storage failure from becoming an unhandled rejection or opening the gate.
  wordbankReady.catch(() => {});
  const contentAssembly = createDrawingContentAssembly({ wordbanks, ready: wordbankReady, enabled: drawingEnabled, now: options.now });
  rooms = options.rooms || createDurableRoomStore({storage, now:options.now, scores, ...contentAssembly, ...options.roomOptions});
  const chat = options.chat || createRoomChat({storage, rooms, now:options.now, ...options.chatOptions});
  const preview = options.preview || createRoomPreview({now:options.now,...options.previewOptions});
  const canvases = options.canvases || (drawingEnabled ? createCanvasService({ storage, rooms, now: options.now, ...options.canvasOptions }) : null);
  return {settings,storage,sessions,rooms,chat,preview,wordbanks,wordbankReady,canvases,drawingEnabled,identityRuntime,scores,gameRegistry,poker414Enabled};
}
