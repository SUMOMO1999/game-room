import { isAbsolute } from 'node:path';
import { createNonameRoomBridge } from './noname/room-bridge.mjs';
import { startNonameRelay } from './noname/upstream-relay.mjs';
import { startNonameControl } from './noname/noname-control.mjs';
import { retainedRooms } from './noname/retained-rooms.mjs';
import { refereeClient, checkReferee } from './noname/referee-client.mjs';

export async function startNonameRuntime(env, settings, storage, openEngine) {
  const enabled = env.GAME_ROOM_NONAME_ENABLED ?? '0';
  if (enabled === '0') return null;
  if (enabled !== '1' || !['mock', 'cognito'].includes(settings.mode)) throw Error('Invalid Noname entry configuration');
  const gameOrigin = env.GAME_ROOM_NONAME_ORIGIN;
  const url = new URL(gameOrigin);
  if (gameOrigin !== url.origin || (settings.production && url.protocol !== 'https:') ||
      settings.entries.some(entry => new URL(entry.origin).hostname === url.hostname)) throw Error('Noname requires a separate host for game content');
  const sourcePath = env.GAME_ROOM_NONAME_RELAY_SOURCE ?? '';
  if (!isAbsolute(sourcePath)) throw Error('Expected the pinned native relay source');
  const port = Number(env.GAME_ROOM_NONAME_RELAY_PORT ?? '17882');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid native relay port');
  if (settings.production && !storage) throw new Error('Production Noname requires the game room store');
  if (!openEngine && (settings.production || env.GAME_ROOM_NONAME_REFEREE_SOCKET)) {
    const path = env.GAME_ROOM_NONAME_REFEREE_SOCKET || '/run/noname-referee.sock';
    await checkReferee(path);
    openEngine = refereeClient(path);
  }
  const bridge = createNonameRoomBridge({retention:storage ? retainedRooms(storage) : null, openEngine});
  const socket = env.GAME_ROOM_NONAME_CONTROL_SOCKET || (settings.production ? '/var/lib/game-room/noname-maintenance/control.sock' : null);
  let control;
  try {
    if (socket) control = await startNonameControl({ bridge, path: socket });
    const relay = await startNonameRelay({ bridge, sourcePath, gameOrigin, port });
    try { await bridge.restoreManaged(); }
    catch (error) { await relay.stop(); throw error; }
    let stopping;
    return { bridge, gameOrigin, stop() {
      if (!stopping) stopping = (async () => {
        await bridge.close();
        try { await relay.stop(); } finally { await control?.stop(); }
      })();
      return stopping;
    } };
  } catch (error) { bridge.close(); await control?.stop(); throw error; }
}
