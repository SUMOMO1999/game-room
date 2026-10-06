// A loaded module selects its own fixed mount. Query strings, browser Host and
// forwarded headers never choose a trusted origin, identity or business runtime.
export function entryBase(moduleUrl = import.meta.url) {
  const url = new URL(moduleUrl);
  if (url.protocol === 'file:') return '/';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Unsupported game entry');
  }
  const base = new URL('./', url).pathname;
  if (!['/', '/game/'].includes(base)) throw new TypeError('Unsupported game entry');
  return base;
}

export function gamePath(logicalPath = '/', moduleUrl = import.meta.url) {
  if (typeof logicalPath !== 'string' || !logicalPath.startsWith('/') || logicalPath.startsWith('//')
      || /[\\\x00-\x20\x7f]/.test(logicalPath)) throw new TypeError('Invalid game path');
  const pathname = logicalPath.split(/[?#]/, 1)[0];
  if (pathname.includes('//') || /%(?:2f|5c|2e|25)/i.test(pathname)
      || pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new TypeError('Invalid game path');
  }
  const base = entryBase(moduleUrl);
  return base === '/' ? logicalPath : base.slice(0, -1) + logicalPath;
}

export function entryStorageKey(key, moduleUrl = import.meta.url) {
  if (typeof key !== 'string' || !key || /[\x00-\x1f\x7f]/.test(key)) throw new TypeError('Invalid storage key');
  return entryBase(moduleUrl) === '/' ? key : 'agora-game:' + key;
}
