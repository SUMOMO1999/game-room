import { accountState, loadAccount, loginHref } from './account-client.mjs';
import { entryBase, gamePath } from './entry-path.mjs';
import { mountRoomVoiceControls } from './platform/room-voice-controls.mjs';
import { decodeOptions, mergeOptions, readOptions, writeOptions } from './noname-options-store.mjs';
import { mountFixedGameDocument } from './game-viewport.mjs';

mountFixedGameDocument(window);

const byId = id => document.getElementById(id);
const frame = byId('native');
const entryURL = new URL(location.href);
if (entryURL.searchParams.get('recoverNoname') === '1') {
  entryURL.searchParams.delete('recoverNoname');
  history.replaceState(history.state, '', entryURL);
}
const clientId = crypto.randomUUID();
const requestIdPattern = /^[a-zA-Z0-9_-]{16,80}$/;
const pending = new Set();
let origin, owner, nicknameScope, events, seat, controls, receiveVoice, generation = 0;
let wantedVoiceRoom, suspended = false, replacedWindow = false;
let voiceRetry, voiceDelay = 900, wantedMicrophone = false, liveMicrophone = false;

function rememberVoice(roomId) {
  wantedVoiceRoom = roomId;
  if (!nicknameScope) return;
  try {
    const key = 'noname.voice.' + nicknameScope;
    if (roomId) sessionStorage.setItem(key, roomId);
    else sessionStorage.removeItem(key);
  } catch {}
}

function clearVoiceIntent() {
  clearTimeout(voiceRetry);
  voiceRetry = null;
  voiceDelay = 900;
  wantedMicrophone = liveMicrophone = false;
  rememberVoice(null);
}

async function gamePreferenceKey(userKey) {
  const bytes = new TextEncoder().encode('noname-nickname\0' + userKey);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
}
function nicknamePreference() {
  let saved, avatar;
  try {
    saved = localStorage.getItem('noname.nickname.' + nicknameScope);
    avatar = localStorage.getItem('noname.avatar.' + nicknameScope);
  } catch {}
  return { scope: nicknameScope, saved, avatar, fallback: accountState().profile?.nickname };
}

async function request(action, body) {
  const response = await fetch(gamePath('/api/noname/' + action + '/' + clientId), {
    credentials: 'same-origin', cache: 'no-store', method: body ? 'POST' : 'GET',
    ...(body && { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': accountState().csrf }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '暂时无法连接无名杀。'), { status: response.status });
  return result;
}
function leaveSeat() {
  clearTimeout(voiceRetry);
  voiceRetry = null;
  document.body.classList.remove('at-table');
  const before = controls;
  controls = null;
  seat = null;
  before?.destroy();
  receiveVoice = null;
  byId('voice').hidden = true;
}
function setSeat(next) {
  if (suspended) return;
  if (next.roomId && wantedVoiceRoom && wantedVoiceRoom !== next.roomId) clearVoiceIntent();
  if (seat === next.roomId && controls && next.voice) { restoreVoice(); return; }
  leaveSeat();
  document.body.classList.toggle('at-table', Boolean(next.roomId));
  if (!next.roomId || !next.voice) return;
  seat = next.roomId;
  controls = mountRoomVoiceControls({
    root: byId('voice-actions'),
    compact: { joinRoot: byId('join'), microphoneRoot: byId('mic'), statusRoot: byId('status') },
    onState: state => {
      if (!controls || seat !== next.roomId) return;
      if (state.joined && !state.joining) {
        rememberVoice(seat);
        voiceDelay = 900;
        if (wantedMicrophone && state.mode === 'open' && state.speaking) liveMicrophone = true;
      } else if (!state.joined && !state.joining) restoreVoice();
    },
    transport: {
      reconnectMedia: true,
      subscribe(handler) { receiveVoice = handler; return () => { if (receiveVoice === handler) receiveVoice = null; }; },
      join: () => request('join', {}),
      leave: ({ id }) => request('leave', { id }),
    },
  });
  controls.element.querySelector('.room-voice-leave').addEventListener('click', clearVoiceIntent);
  byId('mic').querySelector('button').addEventListener('click', () => {
    wantedMicrophone = controls.voice.state().mode !== 'open';
    if (!wantedMicrophone) liveMicrophone = false;
  }, {capture:true});
  byId('voice').hidden = false;
  restoreVoice();
}
function restoreVoice() {
  const current = controls, roomId = seat;
  const eligible = () => current && current === controls && roomId && roomId === wantedVoiceRoom &&
    navigator.onLine && !suspended && !document.hidden;
  if (!eligible() || voiceRetry || current.voice.state().joined || current.voice.state().joining) return;
  voiceRetry = setTimeout(async () => {
    voiceRetry = null;
    if (!eligible() || current.voice.state().joined || current.voice.state().joining) return;
    voiceDelay = Math.min(voiceDelay * 2, 16000);
    if (!await current.voice.join() || !eligible()) return;
    // A previously open, live microphone can resume on this page with an
    // existing device grant. A new page, a muted user and a held gesture listen only.
    if (wantedMicrophone && liveMicrophone) {
      const grant = await navigator.permissions?.query({name:'microphone'}).catch(() => null);
      if (grant?.state === 'granted' && eligible() && wantedMicrophone && liveMicrophone) {
        void current.voice.setOpen(true);
      }
    }
  }, voiceDelay);
}
function disconnect() {
  generation++;
  events?.close();
  events = null;
  leaveSeat();
  wantedVoiceRoom = null;
  wantedMicrophone = liveMicrophone = false;
  voiceDelay = 900;
  pending.clear();
  origin = owner = nicknameScope = null;
  frame.hidden = true;
  frame.removeAttribute('src');
}
function notice(text, canRetry = true) {
  byId('message').textContent = text;
  byId('retry').hidden = !canRetry;
  byId('notice').hidden = false;
}
async function start() {
  replacedWindow = false;
  disconnect();
  const version = generation;
  notice('正在打开三国杀…', false);
  try {
    const account = await loadAccount();
    if (version !== generation) return;
    if (!account.authenticated) {
      if (!account.loginReady || account.failureStatus === 503) throw Error('暂时无法确认棋牌室登录。');
      location.replace(loginHref('/noname.html'));
      return;
    }
    const [launch, scope] = await Promise.all([request('launch'), gamePreferenceKey(account.userKey)]);
    if (version !== generation) return;
    origin = new URL(launch.gameOrigin).origin;
    owner = account.userKey;
    nicknameScope = scope;
    if (launch.returnToRoom) {
      try { wantedVoiceRoom = sessionStorage.getItem('noname.voice.' + scope); } catch {}
    } else clearVoiceIntent();
    const source = new URL('/', origin);
    if (launch.returnToRoom) source.searchParams.set('returnToRoom', '1');
    source.searchParams.set('parentOrigin', location.origin);
    source.searchParams.set('entry', entryBase() === '/game/' ? 'agora' : 'direct');
    watchSeat(version);
    frame.hidden = false;
    byId('notice').hidden = true;
    // Give the embedded document its viewport before its first navigation.
    frame.getBoundingClientRect();
    frame.src = source.href;
  } catch (error) {
    if (version === generation) { disconnect(); notice(error.message); }
  }
}
async function verifyPlayer(version) {
  let current;
  try { current = await loadAccount(); }
  catch (error) {
    if (error.status !== 401) return false;
    current = accountState();
  }
  if (version !== generation) return false;
  if (current.authenticated && current.userKey === owner) return true;
  if (current.failureStatus === 503) return false;
  clearVoiceIntent();
  disconnect();
  notice('棋牌室登录已结束。');
  return false;
}
function watchSeat(version) {
  events?.close();
  const stream = new EventSource(gamePath('/api/noname/events/' + clientId));
  events = stream;
  const active = () => events === stream && version === generation && !suspended;
  stream.addEventListener('seat', event => { if (active()) setSeat(JSON.parse(event.data)); });
  stream.addEventListener('voice', event => { if (active()) receiveVoice?.(JSON.parse(event.data)); });
  stream.onerror = () => {
    if (!active()) return;
    // A table notification can reconnect independently of the live media.
    // The server enforces seat removal, logout and expiry of the media lease.
    if (navigator.onLine) void verifyPlayer(version).catch(() => {});
  };
}
window.addEventListener('message', async event => {
  const { type, requestId } = event.data ?? {};
  if (!origin || event.source !== frame.contentWindow || event.origin !== origin) return;
  if (type === 'noname-left-table') { clearVoiceIntent(); return; }
  if (type === 'noname-superseded') {
    replacedWindow = true;
    clearVoiceIntent();
    disconnect();
    notice('已在另一个窗口回到牌桌。要在这里继续，请点重新连接。');
    return;
  }
  if (type === 'noname-save-avatar' && nicknameScope && event.data.scope === nicknameScope) {
    const avatar = event.data.avatar;
    if (typeof avatar === 'string' && /^[\p{L}\p{M}\p{N}_-]{1,100}$/u.test(avatar)) {
      try { localStorage.setItem('noname.avatar.' + nicknameScope, avatar); } catch {}
    }
    return;
  }
  if (type === 'noname-save-nickname' && nicknameScope && event.data.scope === nicknameScope) {
    const name = event.data.name;
    if (typeof name === 'string' && name.length > 0 && name.length <= 12 && !/[<>&\u0000-\u001f]/u.test(name)) {
      try { localStorage.setItem('noname.nickname.' + nicknameScope, name); } catch {}
    }
    return;
  }
  if (type === 'noname-options-request' && nicknameScope && typeof requestId === 'string' && requestIdPattern.test(requestId)) {
    const data = JSON.stringify(readOptions('noname.options.' + nicknameScope));
    event.source.postMessage({ type: 'noname-options-reply', requestId, account: nicknameScope, data }, origin);
    return;
  }
  if (type === 'noname-save-options' && nicknameScope && event.data.account === nicknameScope) {
    const incoming = decodeOptions(event.data.data);
    const key = 'noname.options.' + nicknameScope;
    if (incoming) writeOptions(key, mergeOptions(readOptions(key), incoming));
    return;
  }
  if (type !== 'noname-ticket-request' || typeof requestId !== 'string' || !requestIdPattern.test(requestId) ||
      pending.has(requestId) || pending.size >= 4) return;
  const version = generation;
  pending.add(requestId);
  let result;
  try {
    if (!accountState().csrf && !await verifyPlayer(version)) throw Error('Login unavailable');
    result = { ...await request('ticket', {}), nickname: nicknamePreference() };
  }
  catch { result = { error: true }; }
  finally { pending.delete(requestId); }
  if (version === generation && event.source === frame.contentWindow) {
    event.source.postMessage({ type: 'noname-ticket', requestId, ...result }, origin);
  }
});
byId('retry').addEventListener('click', start);
window.addEventListener('pagehide', event => {
  if (!event.persisted) { disconnect(); return; }
  suspended = true;
  events?.close();
  events = null;
  leaveSeat();
});
async function resumePage() {
  if (replacedWindow) return;
  const version = generation;
  if (!origin) { if (!suspended) void start(); return; }
  try {
    if (await verifyPlayer(version) && !suspended) {
      if (!events) watchSeat(version); else restoreVoice();
    }
  } catch { /* A network interruption leaves the existing table in memory. */ }
}
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  suspended = false;
  void resumePage();
});
window.addEventListener('online', () => { if (!suspended) void resumePage(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && !suspended) void resumePage(); });
start();
