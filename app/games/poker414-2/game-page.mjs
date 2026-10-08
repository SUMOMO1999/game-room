import { mountPoker414Page } from './page-ui.mjs';
import { createPoker414RoomController } from './room-controller.mjs';
import { RoomClient, api, forgetMembership } from '../../room-client.mjs';
import { accountState, accountGeneration, onAccountChange, loadAccount, watchAccountLifecycle,
  loginHref, reauthenticationHref, logoutAccount } from '../../account-client.mjs';
import { mountRoomChat } from '../../room-chat.mjs';
import { roomHref } from '../../game-routing.mjs';
import { entryBase } from '../../entry-path.mjs';

let controller;
const ui = mountPoker414Page({ root: document.querySelector('#poker414-root'),
  onAction: (type, fields) => controller.act(type, fields), onLeave: options => controller.leave(options),
  onRefresh: () => controller.refresh(), onRetry: () => controller.retry(), onRecover: () => controller.recover() });
const chat = mountRoomChat({ onCue: kind => ui.audio.play(kind), onUnavailable: error => controller.unavailable(error) });
controller = createPoker414RoomController({ roomCode: new URLSearchParams(location.search).get('code') || '',
  document, window, ui, chat, RoomClient, api, accountState, accountGeneration, onAccountChange, loadAccount,
  watchAccountLifecycle, loginHref, reauthenticationHref, logoutAccount, forgetMembership, roomHref,
  agoraHref: entryBase() === '/game/' ? '/#projects' : 'https://agora.sumomoli.com/#projects' });
void controller.start();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
