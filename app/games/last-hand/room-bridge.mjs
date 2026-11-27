import { accountState, loadAccount } from '../../account-client.mjs';
import { api, RoomClient } from '../../room-client.mjs';
import { mountRoomVoiceControls } from '../../platform/room-voice-controls.mjs';
import { withRoomVoice } from '../../platform/room-voice-session.mjs';
import { gamePath } from '../../entry-path.mjs';

const gameType = 'last-hand';
const TableRoomClient = withRoomVoice(RoomClient, {
  gameType,
  createControls: options => mountRoomVoiceControls({ ...options, listeningHint: '已加入，点右上角的麦克风发言。' }),
});

export async function request(path = '', payload) {
  if (!path && !payload) {
    const account = await loadAccount();
    if (!account.authenticated) return { signedOut: true, recent: [], publicRooms: [] };
    const { publicRooms } = await api('/api/last-hand/tables');
    return { nickname: account.profile?.nickname, recent: account.recentRooms.filter(r => r.gameType === gameType), publicRooms };
  }
  let body = payload;
  if (payload && path.endsWith('/join')) body = { ...payload, expectedGameType: gameType };
  if (!path && payload) {
    const { name, settings, requestId } = payload;
    body = { name, requestId, gameType, initialConfiguration: { tableOptions: settings } };
  }
  const endpoint = '/api/rooms' + path.replace(/\/act$/, '/actions');
  const reply = await api(endpoint, body ? { method: 'POST', body } : {});
  if (reply.view && reply.view.gameType !== gameType)
    throw Error('这张桌属于另一款游戏，请从棋牌室大厅进入。');
  return !body && /^\/\d{6}$/.test(path) ? reply.view : reply;
}

// The shared client checks membership and account changes before showing a private view.
export function watchSeat(first, accept, connected, reconnect, onChat) {
  const code = first.roomCode;
  const client = new TableRoomClient(code, { playerId: first.selfId }, {
    keepBackgroundStream: true,
    onView: accept,
    onConnection(state) {
      connected(state === 'online');
      if (state === 'online') void reconnect();
    },
    onChat,
    onError(error) {
      if ([401, 403, 404].includes(error.status) || !accountState().authenticated)
        document.dispatchEvent(new Event('last-hand-seat-ended'));
      else connected(false);
    },
  });
  client.receive(first);
  client.connect();
  return { close() { client.stop(); }, client };
}

export const lobbyHref = () => gamePath('/');
