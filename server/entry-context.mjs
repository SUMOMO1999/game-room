// Only the HTTP server binds this immutable context after checking fixed entries.
// Host/Origin must match the configured entry; forwarding headers never select it.
import { safeReturnTo } from './config.mjs';

const requestEntries = new WeakMap();
export function entryPath(entry, logicalPath = '/') {
  if (typeof logicalPath !== 'string' || !logicalPath.startsWith('/') || logicalPath.startsWith('//')) throw new TypeError('Expected a logical absolute path');
  return entry.basePath === '/' ? logicalPath : entry.basePath.slice(0, -1) + logicalPath;
}
export function entryReturnTo(value, entry) {
  // Accept both logical app paths and the current browser's external mounted path.
  // Store only the logical form so callback mapping never adds the prefix twice.
  const logical = entry.basePath !== '/' && typeof value === 'string' && value.startsWith(entry.basePath)
    ? '/' + value.slice(entry.basePath.length) : value;
  return safeReturnTo(logical, entry.origin);
}
export function makeEntries(settings, input) {
  const definitions = input === undefined ? [{ id: 'direct', origin: settings.origin, basePath: '/' }] : input;
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 2) throw new TypeError('Expected one or two fixed game entries');
  const entries = definitions.map(definition => {
    if (!definition || typeof definition !== 'object') throw new TypeError('Invalid fixed game entry');
    const { id, origin, basePath } = definition;
    if (!((id === 'direct' && basePath === '/' && origin === settings.origin) || (id === 'agora' && basePath === '/game/'))) throw new TypeError('Unsupported fixed game entry');
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new TypeError('Expected an exact fixed entry origin');
    if (settings.production && url.protocol !== 'https:') throw new TypeError('Production entries require HTTPS');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new TypeError('HTTP entries require loopback');
    const direct = id === 'direct';
    const secureCookies = url.protocol === 'https:' || direct && settings.secureCookies;
    const cookiePrefix = secureCookies ? '__Host-' : '';
    const entry = { id, origin, host: url.host, basePath, secureCookies,
      key: `${id}|${origin}|${basePath}`, direct,
      cookieName: direct ? settings.cookieName : `${cookiePrefix}game-room-${id}-session`,
      transactionCookieName: direct ? settings.transactionCookieName : `${cookiePrefix}game-room-${id}-transaction` };
    entry.callback = `${origin}${entryPath(entry, '/auth/callback')}`;
    entry.postLogout = `${origin}${basePath}`;
    return Object.freeze(entry);
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length || new Set(entries.map(entry => `${entry.host}|${entry.basePath}`)).size !== entries.length) throw new TypeError('Duplicate fixed entry');
  return Object.freeze(entries);
}
export function resolveEntry(request, entries) {
  const target = request.url || '';
  const rawPath = target.split('?')[0];
  // App routes/assets have literal ASCII paths. Encoded paths are unnecessary and
  // rejected, including recursive encodings, before URL parsing can normalize them.
  if (!target.startsWith('/') || /[\\\x00-\x20\x7f#]/.test(target) || rawPath.includes('//') || rawPath.includes('%') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) throw new TypeError('Invalid game request target');
  for (const name of ['host', 'origin']) {
    if (request.rawHeaders?.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length > 1) throw new TypeError('Duplicate game entry header');
  }
  const entry = [...entries].sort((a, b) => b.basePath.length - a.basePath.length).find(candidate => candidate.host === request.headers.host && (candidate.basePath === '/' || rawPath.startsWith(candidate.basePath)));
  if (!entry) throw new TypeError('No trusted game entry');
  const externalUrl = new URL(target, entry.origin);
  if (externalUrl.origin !== entry.origin || !externalUrl.pathname.startsWith(entry.basePath)) throw new TypeError('Invalid game entry path');
  const logicalPath = entry.basePath === '/' ? externalUrl.pathname : '/' + externalUrl.pathname.slice(entry.basePath.length);
  return { entry, externalUrl, logicalPath };
}
export function bindEntry(request, entry, logicalPath) { requestEntries.set(request, Object.freeze({ entry, logicalPath })); }
export function requestContext(request) { return requestEntries.get(request); }
export function entryFor(request, settings) { return requestContext(request)?.entry || makeEntries(settings)[0]; }
export function recordMatchesEntry(record, entry) { return Boolean(record && (record.entryKey === entry.key || entry.direct && !Object.hasOwn(record, 'entryKey'))); }
