import { gamePresentations } from '../app/games/catalog.mjs';

const platformAssets = Object.freeze(['index.html', 'lobby.mjs', 'lobby-model.mjs', 'lobby.css',
  'practice-hub.html', 'practice-hub.mjs', 'practice-hub.css',
  'account-client.mjs', 'room-client.mjs', 'room-chat.mjs', 'entry-path.mjs', 'game-routing.mjs',
  'game-viewport.mjs', 'game-audio.mjs', 'game-presentation.mjs', 'board-layout.mjs', 'styles.css',
  'favicon.svg', 'app-shell.mjs', 'app-shell.css', 'practice-entry.css', 'manifest.webmanifest',
  'sw.js', 'offline.html', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'games/catalog.mjs', 'games/types.mjs', 'platform/room-presentation.mjs', 'platform/room-clock.mjs',
  'vendor/livekit-client-2.22.4.esm.mjs', 'vendor/livekit-license.html', 'platform/room-voice.mjs', 'platform/room-voice-controls.mjs', 'platform/room-voice-policy.mjs', 'platform/room-voice-session.mjs', 'platform/room-voice-host.mjs', 'platform/room-voice-host.css', 'platform/room-voice.css',
  'platform/room-session.mjs', 'platform/room-audio-controls.mjs', 'platform/room-viewport.mjs', 'platform/game-stage-fit.mjs', 'platform/object-motion.mjs',
  'platform/room-action-intent.mjs', 'platform/card-room-controller.mjs', 'platform/room-settings.mjs', 'platform/room-settings.css', 'platform/control-geometry.css', 'platform/game-theme.mjs', 'platform/game-theme.css', 'platform/practice-navigation.mjs',
  'platform/game-appearance.mjs', 'platform/game-appearance.css', 'platform/appearance-bootstrap.mjs', 'platform/appearance-data.mjs',
  'platform/appearance-menu.css', 'platform/appearance-menu-template.mjs']);

// This remains an explicit allow-list, not a recursive publication of app/.
export function publicAssetPaths(games = gamePresentations(), shared = platformAssets) {
  const paths = [...shared, ...games.flatMap(game => game.assets)];
  const forbidden = /(?:^|\/)(?:server|private|test-support|tests|__tests__|fixtures|__fixtures__|node_modules|ops|specs)(?:\/|$)|(?:^|\/)(?:rooms|game-registry|multiplayer-rules|army-rules|adapter|multiplayer)\.mjs$|games\/army-flip\/rules\.mjs$|(?:^|\/)(?:hyakki|poker414|parks)-preview\.html$|games\/(?:hyakki-trading|poker414-2)\/(?:digital-)?preview\.mjs$|games\/parks\/(?:preview(?:-fixtures)?|page-ui|engine)\.mjs$|\.test\.mjs$/;
  for (const file of paths) {
    if (typeof file !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file)
      || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')
      || !/\.(?:html|css|mjs|js|svg|png|webp|webmanifest)$/.test(file) || forbidden.test(file)) {
      throw new TypeError('静态公开资源包含不安全路径。');
    }
  }
  return Object.freeze([...new Set(paths)].sort());
}
