import { entryBase, gamePath, entryStorageKey } from './entry-path.mjs';
import { normalizeRecentRoom } from './lobby-model.mjs';

const EMPTY = { mode: 'legacy', loginReady: false, authenticated: false, userKey: null,
  csrf: null, profile: null, recentRooms: [], failureStatus: null, reauthReady: false, reauthHref: null };
export const ACCOUNT_CHECK_INTERVAL_MS = 15000;
export const ACCOUNT_CHECK_TIMEOUT_MS = 10000;
let state = { ...EMPTY };
let verification = 'checking';
let generation = 0;
let loadSequence = 0;
let logoutInFlight = 0;
const listeners = new Set();
const loopback = () => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(globalThis.location?.hostname);
const signature = (value) => JSON.stringify([value.mode, value.authenticated, value.userKey, value.csrf]);
const copy = (value) => structuredClone(value);
const DRAFT_OWNER_KEY = entryStorageKey('game-room.private-draft-owner.v1');
// This marker is only the last verified identity's non-authorizing local namespace.
// It never restores authentication, a CSRF value, a seat or a private view.
let retainedDraftOwner = null;
try {
  const saved = globalThis.sessionStorage?.getItem?.(DRAFT_OWNER_KEY);
  if (typeof saved === 'string' && /^[a-f0-9]{64}$/.test(saved)) retainedDraftOwner = saved;
} catch { /* In-memory fencing still works when storage is unavailable. */ }
function retainDraftOwner(userKey) {
  retainedDraftOwner = userKey;
  try {
    if (userKey) globalThis.sessionStorage?.setItem?.(DRAFT_OWNER_KEY, userKey);
    else globalThis.sessionStorage?.removeItem?.(DRAFT_OWNER_KEY);
  } catch { /* Draft persistence is optional. */ }
}
function removePrivateDrafts(userKey) {
  if (!userKey) return;
  try {
    const storage = globalThis.sessionStorage;
    const prefix = entryStorageKey(`game-room.private-draft.${userKey}.`);
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch { /* Private storage may be disabled. The epoch still invalidates replies. */ }
}

export function accountState() { return copy({ ...state, verification }); }
export function accountGeneration() { return generation; }
export function onAccountChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function update(next, force = false, { preserveDraft = false } = {}) {
  if (force || signature(next) !== signature(state)) {
    const previousUser = state.userKey || retainedDraftOwner;
    if (preserveDraft) retainDraftOwner(previousUser);
    else {
      // Same-identity revalidation can recover a local draft; expiry, logout and
      // explicit identity changes remove the old identity's private namespace.
      if (!next.authenticated || next.userKey !== previousUser) removePrivateDrafts(previousUser);
      retainDraftOwner(null);
    }
    generation += 1;
  }
  if(next.authenticated) retainDraftOwner(null);
  state = next;
  for (const listener of [...listeners]) { try { listener(accountState()); } catch { /* Isolate page subscribers. */ } }
  return accountState();
}
function cleared(status = null, mode = state.mode) {
  return { ...EMPTY, mode, loginReady: state.loginReady, reauthReady: state.reauthReady,
    reauthHref: state.reauthHref, failureStatus: status };
}
function normalize(value) {
  if (!value || !['legacy', 'disabled', 'mock', 'cognito'].includes(value.mode)
      || (value.mode === 'legacy' && !loopback())) throw Object.assign(new Error('登录状态暂时无法确认。'), { status: 503 });
  const authenticated = value.authenticated === true;
  if (authenticated && (typeof value.userKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.userKey)
      || typeof value.csrf !== 'string' || !value.csrf || value.csrf.length > 256)) {
    throw Object.assign(new Error('登录状态暂时无法确认。'), { status: 503 });
  }
  const profile = authenticated && value.profile && typeof value.profile === 'object' ? {
    userKey: value.userKey, nickname: typeof value.profile.nickname === 'string' ? value.profile.nickname : null,
    createdAt: value.profile.createdAt, updatedAt: value.profile.updatedAt,
  } : null;
  const recentRooms = authenticated && Array.isArray(value.recentRooms)
    ? value.recentRooms.map(normalizeRecentRoom).filter(Boolean).slice(0, 8) : [];
  return { mode: value.mode, loginReady: value.loginReady === true, drawingEnabled: value.drawingEnabled === true, authenticated,
    userKey: authenticated ? value.userKey : null, csrf: authenticated ? value.csrf : null,
    profile, recentRooms, expiresAt: authenticated ? value.expiresAt : null,
    idleUntil: authenticated ? value.idleUntil : null, failureStatus: null,
    reauthReady: value.reauthReady === true, reauthHref: normalizeReauthHref(value.reauthHref) };
}
function normalizeReauthHref(value) {
  // The central recovery destination must be explicitly supplied by our BFF.
  // Never derive a route from browser input or accept tokens/return URLs here.
  if(typeof value!=='string' || value.length>256) return null;
  try {
    const url=new URL(value);
    return url.origin==='https://agora.sumomoli.com' && url.pathname==='/'
      && !url.search && !url.username && !url.password && (!url.hash || url.hash==='#account') ? url.href : null;
  } catch { return null; }
}
export function reauthenticationHref() {
  return state.reauthReady && state.reauthHref ? (entryBase() === '/game/' ? '/#account' : state.reauthHref) : null;
}
export function reportAuthFailure(error) {
  if (![401, 503].includes(error?.status)) return;
  verification=error.status===503?'unavailable':'anonymous';
  update(cleared(error.status, state.mode === 'legacy' ? 'disabled' : state.mode), true, { preserveDraft: error.status === 503 });
}
export async function loadAccount() {
  // The cookie can remain valid until the logout response arrives. A visibility refresh must not undo the local fence.
  if (logoutInFlight) return accountState();
  const epoch = generation;
  const sequence = ++loadSequence;
  const controller=new AbortController();let timer;
  try {
    const request=(async()=>{
      const response=await fetch(gamePath('/api/state'),{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});
      const data=response.status===404 && loopback()?null:await response.json();
      return {response,data};
    })();
    const timeout=new Promise((_,reject)=>{
      timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('登录核验暂时未完成，请稍后重试。'),{status:503}));},ACCOUNT_CHECK_TIMEOUT_MS);
      timer.unref?.();
    });
    const {response,data}=await Promise.race([request,timeout]);
    if (epoch !== generation || sequence !== loadSequence) return accountState();
    if (response.status === 404 && loopback()) {verification='verified';return update({ ...EMPTY });}
    if (!response.ok) throw Object.assign(new Error(data.error || '登录状态暂时无法确认。'), { status: response.status === 401 ? 401 : 503 });
    const next=normalize(data);verification='verified';return update(next);
  } catch (failure) {
    if (epoch !== generation || sequence !== loadSequence) return accountState();
    const error = Object.assign(new Error(failure.message || '登录状态暂时无法确认。'), { status: failure.status === 401 ? 401 : 503 });
    reportAuthFailure(error);
    throw error;
  } finally {clearTimeout(timer);}
}
// Navigation restoration and window activation must recheck our own cookie, including Safari returns that
// do not report a persisted page. If an older anonymous check is still in flight, run one fresh check after it.
export function watchAccountLifecycle({ windowRef = globalThis.window, documentRef = globalThis.document,
  onError = () => {}, onSuspend = () => {}, onVerified = () => {},
  timers = globalThis, intervalMs = ACCOUNT_CHECK_INTERVAL_MS } = {}) {
  let stopped = false;
  let running = null;
  let requested = false;
  let timer=null;
  function suspend(reason='checking') {
    loadSequence++;
    retainDraftOwner(state.userKey || retainedDraftOwner);
    verification=reason==='hidden'?'paused':'checking';
    timers.clearTimeout(timer);timer=null;
    try {onSuspend(reason);} catch {reportAuthFailure({status:503});}
  }
  function schedule() {
    timers.clearTimeout(timer);timer=null;
    if(stopped || documentRef?.hidden) return;
    timer=timers.setTimeout(()=>refresh({conceal:false,reason:'periodic'}),intervalMs);
    timer?.unref?.();
  }
  function refresh({conceal=true,reason='checking'}={}) {
    if (stopped || documentRef?.hidden) return Promise.resolve(accountState());
    if(conceal) suspend(reason);
    if (running) { requested = {conceal:requested?.conceal===true || conceal,reason}; return running; }
    running = Promise.resolve().then(() => loadAccount()).catch((error) => {
      if (!stopped) { try { onError(error); } catch { /* Keep lifecycle listeners independent from page rendering. */ } }
      return accountState();
    }).finally(() => {
      running = null;
      if (requested && !stopped) { const next=requested; requested = false; return refresh(next); }
      if(!stopped && !documentRef?.hidden && verification==='verified') {
        try {onVerified(accountState(),{reason});} catch {reportAuthFailure({status:503});}
      }
      schedule();
    });
    return running;
  }
  const revalidate = () => { refresh({reason:'return'}); };
  // Window activation alone is not background restoration. Recheck freshly,
  // but keep a still-verified visible table until the response proves a failure.
  const focus = () => { refresh({conceal:verification!=='verified',reason:'focus'}); };
  const visibility = () => {if(documentRef?.hidden) {requested=false;suspend('hidden');} else revalidate();};
  const pagehide = () => {requested=false;suspend('hidden');};
  windowRef?.addEventListener?.('pageshow', revalidate);
  windowRef?.addEventListener?.('focus', focus);
  windowRef?.addEventListener?.('pagehide', pagehide);
  documentRef?.addEventListener?.('visibilitychange', visibility);
  return { refresh, stop() {
    stopped = true; requested = false;
    suspend('hidden');
    windowRef?.removeEventListener?.('pageshow', revalidate);
    windowRef?.removeEventListener?.('focus', focus);
    windowRef?.removeEventListener?.('pagehide', pagehide);
    documentRef?.removeEventListener?.('visibilitychange', visibility);
  } };
}
let channel = null;
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel('game-room-account-v1');
  channel.onmessage = (event) => {
    if (event.data?.type === 'logout') {verification='anonymous';update(cleared(), true);}
  };
  channel.unref?.();
}
export async function logoutAccount() {
  const current = accountState();
  logoutInFlight += 1;
  // Fence all pending private replies immediately, even while the logout POST is still in flight.
  verification='anonymous';
  update(cleared(), true);
  const epoch = generation;
  try {
    let response;
    try {
      response = await fetch(gamePath('/auth/logout'), { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(current.csrf ? { 'X-CSRF-Token': current.csrf } : {}) }, body: '{}' });
    } catch {
      const error = Object.assign(new Error('退出棋牌暂未完成，请稍后重试。'), { status: 503 });
      if (epoch === generation) reportAuthFailure(error);
      throw error;
    }
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    if (!response.ok) {
      const error = Object.assign(new Error(data.error || '退出棋牌暂未完成，请重试。'), { status: response.status });
      if (epoch === generation && [401, 503].includes(error.status)) reportAuthFailure(error);
      throw error;
    }
    verification='anonymous';update(cleared());
    channel?.postMessage({ type: 'logout' });
    return data;
  } finally {
    logoutInFlight -= 1;
  }
}
export function loginHref(returnTo = '/') {
  if (typeof returnTo !== 'string' || !/^(?:\/|\/\?room=\d{6}|\/(?:room|army)\.html\?code=\d{6})$/.test(returnTo)) returnTo = '/';
  return gamePath(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}
