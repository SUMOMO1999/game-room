import { isAbsolute } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';

export const SHARED_ISSUER = 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_HvamEWPsq';
export const SHARED_AUTH_DOMAIN = 'https://sumomo-agora.auth.ap-northeast-1.amazoncognito.com';
export const FORBIDDEN_CLIENT_IDS = new Set(['15ieknek25quijgqdqcd8rfmom', '5dkhqk318ogvf9qjvp0p5m7dfi', '27ol1sbgk8g9c4deeqvjcifs77']);
export const PRODUCTION_GAME_CLIENT_ID = '27oe1fs5shskll808e733lqm65';
const productionGameOrigin = 'https://game.sumomoli.com';
const productionAgoraOrigin = 'https://agora.sumomoli.com';
const loopbackHost = (value) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value);
const duration = (value, fallback, maximum, label) => {
  const seconds = Number(value ?? fallback);
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > maximum) throw new Error(`Invalid ${label}`);
  return seconds * 1000;
};

// Read once on startup. The credential never enters a release bundle or HTTP response.
export function isSystemdStoreCredential(env, fileInfo, directoryInfo) {
  const directory = env.CREDENTIALS_DIRECTORY;
  return Boolean(directory && /^\/run\/credentials\/game-room(?:-(?:backup|manual-backup|restore|preflight-[a-f0-9]{20}))?\.service$/.test(directory)
    && env.GAME_ROOM_STORE_KEY_FILE === `${directory}/store-key`
    && directoryInfo?.isDirectory() && directoryInfo.uid === 0 && !(directoryInfo.mode & 0o022)
    && fileInfo.isFile() && fileInfo.uid === 0 && !(fileInfo.mode & 0o337));
}
export function readStoreKey(env = process.env) {
  if (env.GAME_ROOM_STORE_KEY && env.GAME_ROOM_STORE_KEY_FILE) throw new Error('Choose one server-only store key source');
  let encoded = env.GAME_ROOM_STORE_KEY;
  if (env.GAME_ROOM_STORE_KEY_FILE) {
    if (!isAbsolute(env.GAME_ROOM_STORE_KEY_FILE)) throw new Error('Store key file requires an absolute path');
    try {
      const info = lstatSync(env.GAME_ROOM_STORE_KEY_FILE);
      let credential = false;
      const directory = env.CREDENTIALS_DIRECTORY;
      if (directory && /^\/run\/credentials\/game-room(?:-(?:backup|manual-backup|restore|preflight-[a-f0-9]{20}))?\.service$/.test(directory) && env.GAME_ROOM_STORE_KEY_FILE === `${directory}/store-key`) {
        const dirInfo = lstatSync(directory);
        // systemd may retain root ownership and grant this service UID read access via ACL.
        credential = isSystemdStoreCredential(env, info, dirInfo);
      }
      if (!info.isFile() || info.size > 128 || (!credential && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) throw new Error();
      encoded = readFileSync(env.GAME_ROOM_STORE_KEY_FILE, 'utf8').trim();
    } catch { throw new Error('Store key file must be a readable owner-only regular file'); }
  }
  if (!encoded) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded) || Buffer.from(encoded, 'base64url').length !== 32 || Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) throw new Error('Store key must contain 32 server-only bytes');
  return Buffer.from(encoded, 'base64url');
}

export function readSettings(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const drawingFlag = env.GAME_ROOM_DRAWING_ENABLED;
  if (drawingFlag !== undefined && !['0', '1'].includes(drawingFlag)) throw new Error('Drawing entry requires an explicit 0 or 1');
  const poker414Flag = env.GAME_ROOM_POKER414_ENABLED;
  if (poker414Flag !== undefined && !['0', '1'].includes(poker414Flag)) throw new Error('414 entry requires an explicit 0 or 1');
  const hyakkiFlag = env.GAME_ROOM_HYAKKI_ENABLED;
  if (hyakkiFlag !== undefined && !['0', '1'].includes(hyakkiFlag)) throw new Error('Hyakki entry requires an explicit 0 or 1');
  const agoraFlag = env.GAME_ROOM_AGORA_ENTRY_ENABLED;
  if (agoraFlag !== undefined && agoraFlag !== '0' && agoraFlag !== '1') throw new Error('Agora game entry requires an explicit 0 or 1');
  const agoraEntryEnabled = agoraFlag === '1';
  if (agoraEntryEnabled && !production) throw new Error('Configured Agora game entry is production-only');
  const mode = env.GAME_ROOM_AUTH_MODE || (production ? 'disabled' : 'legacy');
  if (!['legacy', 'disabled', 'mock', 'cognito'].includes(mode)) throw new Error('Invalid game-room identity mode');
  if (poker414Flag === '1' && !['mock', 'cognito'].includes(mode)) throw new Error('414 requires unified member accounts');
  if (hyakkiFlag === '1' && !['mock', 'cognito'].includes(mode)) throw new Error('Hyakki requires unified member accounts');
  const refreshFlag = env.GAME_ROOM_SESSION_REFRESH_ENABLED;
  if (refreshFlag !== undefined && !['0', '1'].includes(refreshFlag)) throw new Error('Session refresh requires an explicit 0 or 1');
  const sessionRefreshEnabled = refreshFlag === '1';
  if (sessionRefreshEnabled && mode !== 'cognito') throw new Error('Session refresh requires the dedicated Cognito client');
  const days = env.GAME_ROOM_SESSION_MAX_DAYS ?? '30';
  if (!/^(?:[1-9]|[12][0-9]|30)$/.test(days)) throw new Error('Session retention requires 1 to 30 whole days');
  const batchFlag = env.GAME_ROOM_IDENTITY_BATCH_ENABLED;
  if (batchFlag !== undefined && !['0', '1'].includes(batchFlag)) throw new Error('Identity batch requires an explicit 0 or 1');
  const identityBatchEnabled = batchFlag === '1';
  // The faster legacy-check schedule is opt-in only after Agora's dedicated
  // route allocation is installed and read back. Existing starts stay at 4rps.
  const identityInterval = env.GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS;
  if (identityInterval !== undefined && !['125', '250'].includes(identityInterval))
    throw new Error('Identity check interval requires an explicit 125 or 250');
  const identityCheckIntervalMs = Number(identityInterval ?? '250');
  if (identityCheckIntervalMs === 125 && (mode !== 'cognito' || identityBatchEnabled))
    throw new Error('Faster identity checks require the legacy Cognito provider');
  if (identityBatchEnabled && (mode !== 'cognito'
      || !/^[a-z][a-z0-9._-]{0,63}$/.test(env.GAME_ROOM_IDENTITY_BATCH_KEY_ID || '')
      || !isAbsolute(env.GAME_ROOM_IDENTITY_BATCH_KEY_FILE || ''))) throw new Error('Identity batch requires a dedicated signing key and Cognito mode');
  const origin = new URL(env.GAME_ROOM_ORIGIN || (production ? 'https://game.sumomoli.com' : `http://127.0.0.1:${env.GAME_ROOM_PORT || 4177}`));
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Expected an exact game-room origin');
  if (production && (mode !== 'cognito' || origin.protocol !== 'https:')) throw new Error('Production requires HTTPS Cognito authentication');
  if (!production && !loopbackHost(origin.hostname)) throw new Error('Local development requires a loopback origin');
  const host = env.GAME_ROOM_HOST || '127.0.0.1';
  if (!loopbackHost(host)) throw new Error('Server must bind to loopback behind the HTTPS proxy');
  const port = Number(env.GAME_ROOM_PORT || 4177);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid game-room port');
  const settings = {
    drawingEnabled: drawingFlag === '1',
    poker414Enabled: poker414Flag === '1',
    hyakkiEnabled: hyakkiFlag === '1',
    identityBatchEnabled,
    identityCheckIntervalMs,
    ...(identityBatchEnabled ? { identityBatchKeyId: env.GAME_ROOM_IDENTITY_BATCH_KEY_ID,
      identityBatchKeyFile: env.GAME_ROOM_IDENTITY_BATCH_KEY_FILE } : {}),
    production, mode, origin: origin.origin, host, port, secureCookies: origin.protocol === 'https:',
    sessionRefreshEnabled, sessionMaxDays: Number(days),
    callback: `${origin.origin}/auth/callback`, postLogout: `${origin.origin}/`,
    cookieName: origin.protocol === 'https:' ? '__Host-game-room-session' : 'game-room-dev-session',
    transactionCookieName: origin.protocol === 'https:' ? '__Host-game-room-transaction' : 'game-room-dev-transaction',
    absoluteMs: duration(env.GAME_ROOM_SESSION_ABSOLUTE_SECONDS, 3600, 3600, 'absolute session duration'),
    idleMs: duration(env.GAME_ROOM_SESSION_IDLE_SECONDS, 1800, 1800, 'idle session duration'),
    positiveCacheMs: duration(env.GAME_ROOM_READ_CACHE_SECONDS, 60, 60, 'read identity cache duration'),
    transactionMs: 300_000, checkTimeoutMs: 8000,
    mockSub: env.GAME_ROOM_MOCK_SUB || 'synthetic-player',
    storePath: env.GAME_ROOM_STORE_PATH || null,
  };
  if (mode === 'cognito') {
    if (!env.GAME_ROOM_CLIENT_ID) throw new Error('A dedicated game-room client is required');
    const clientId = env.GAME_ROOM_CLIENT_ID;
    if (!/^[a-z0-9]{8,128}$/.test(clientId) || FORBIDDEN_CLIENT_IDS.has(clientId)) throw new Error('Game-room requires its own client identifier');
    const issuer = new URL(env.GAME_ROOM_ISSUER || SHARED_ISSUER);
    const authDomain = new URL(env.GAME_ROOM_AUTH_DOMAIN || SHARED_AUTH_DOMAIN);
    if (issuer.href.replace(/\/$/, '') !== SHARED_ISSUER || authDomain.origin !== SHARED_AUTH_DOMAIN || authDomain.pathname !== '/' || authDomain.search || authDomain.hash || authDomain.username || authDomain.password) throw new Error('Unexpected shared identity configuration');
    Object.assign(settings, { issuer: SHARED_ISSUER, authDomain: SHARED_AUTH_DOMAIN, clientId });
  }
  settings.storeKey = readStoreKey(env);
  if (production && (!settings.storeKey || !settings.storePath || !isAbsolute(settings.storePath))) throw new Error('Production requires a persistent store and server-only encryption key');
  if (agoraEntryEnabled && (settings.origin !== productionGameOrigin || settings.clientId !== PRODUCTION_GAME_CLIENT_ID)) throw new Error('Agora game entry requires the existing production game origin and dedicated client');
  settings.agoraEntryEnabled = agoraEntryEnabled;
  // Only startup configuration chooses trusted entries. Request headers cannot
  // add origins, change the mount, or select another project's client.
  settings.entries = Object.freeze([
    Object.freeze({ id: 'direct', origin: settings.origin, basePath: '/' }),
    ...(agoraEntryEnabled ? [Object.freeze({ id: 'agora', origin: productionAgoraOrigin, basePath: '/game/' })] : []),
  ]);
  return settings;
}

// URL text is checked before parsing: encoded delimiters and duplicate parameters never enter a transaction.
export function safeReturnTo(value, origin) {
  if (typeof value !== 'string' || value.length > 80 || /[\\\x00-\x20\x7f%#]/.test(value)) return '/';
  if (!/^(?:\/|\/\?room=\d{6}|\/words(?:\.html)?|\/(?:room|army|flying|drawing|poker414|hyakki)\.html\?code=\d{6})$/.test(value)) return '/';
  try { return new URL(value, origin).origin === origin ? value : '/'; } catch { return '/'; }
}
