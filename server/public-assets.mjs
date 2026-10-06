import { gamePresentations } from '../app/games/catalog.mjs';

const platformAssets = Object.freeze(['index.html', 'lobby.mjs', 'lobby-model.mjs', 'lobby.css',
  'account-client.mjs', 'room-client.mjs', 'room-chat.mjs', 'entry-path.mjs', 'game-routing.mjs',
  'game-viewport.mjs', 'game-audio.mjs', 'game-presentation.mjs', 'board-layout.mjs', 'styles.css',
  'favicon.svg', 'app-shell.mjs', 'app-shell.css', 'practice-entry.css', 'manifest.webmanifest',
  'sw.js', 'offline.html', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'games/catalog.mjs', 'games/types.mjs', 'platform/room-presentation.mjs', 'platform/room-clock.mjs',
  'platform/room-session.mjs', 'platform/room-audio-controls.mjs', 'platform/room-viewport.mjs',
  'platform/room-action-intent.mjs', 'platform/room-settings.mjs', 'platform/room-settings.css', 'platform/practice-navigation.mjs']);

// This remains an explicit allow-list, not a recursive publication of app/.
export function publicAssetPaths(games = gamePresentations(), shared = platformAssets) {
  const paths = [...shared, ...games.flatMap(game => game.assets)];
  const forbidden = /(?:^|\/)(?:server|private|test-support|tests|__tests__|fixtures|__fixtures__|node_modules|ops|specs)(?:\/|$)|(?:^|\/)(?:rooms|game-registry|multiplayer-rules|army-rules|adapter|multiplayer)\.mjs$|games\/army-flip\/rules\.mjs$|\.test\.mjs$/;
  for (const file of paths) {
    if (typeof file !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file)
      || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')
      || !/\.(?:html|css|mjs|js|svg|png|webmanifest)$/.test(file) || forbidden.test(file)) {
      throw new TypeError('静态公开资源包含不安全路径。');
    }
  }
  return Object.freeze([...new Set(paths)].sort());
}
