const input = new URL(location.href).searchParams;
const destination = new URL('./index.html', import.meta.url);
const code = input.get('code');
if (/^\d{6}$/.test(code || '')) destination.searchParams.set('room', code);
else if (input.get('play') === 'friends') destination.searchParams.set('play', 'friends');

async function enterTable() {
  const scope = new URL('./', destination);
  const registration = await navigator.serviceWorker?.getRegistration(destination.href);
  if (registration?.scope !== scope.href || !registration.active) return;

  // This launcher is outside the table worker's scope. It can see the current
  // manifest even when another tab is still playing from the previous cache.
  const manifest = await fetch(new URL('offline-list.json', scope), { cache: 'no-store' });
  if (!manifest.ok) return;
  const { build, upgradeFrom } = await manifest.json();
  if (!/^[0-9a-f]{20}$/.test(build)) return;
  const url = new URL('offline-worker.js?build=' + build, scope);
  if (registration.active.scriptURL === url.href) return;
  if (!upgradeFrom?.includes(new URL(registration.active.scriptURL).searchParams.get('build'))) return;

  const link = document.querySelector('a');
  link.href = destination.href;
  link.textContent = '正在更新牌桌…';
  const updated = await navigator.serviceWorker.register(url.href);
  const worker = [updated.installing, updated.waiting, updated.active]
    .find(candidate => candidate?.scriptURL === url.href);
  if (!worker) return;
  await new Promise(resolve => {
    function changed() {
      if (worker.state !== 'activated' && worker.state !== 'redundant') return;
      worker.removeEventListener('statechange', changed);
      resolve();
    }
    worker.addEventListener('statechange', changed);
    changed();
  });
}

// Offline or on a slow connection the previously installed table is still playable.
let timeout;
try {
  await Promise.race([
    enterTable(),
    new Promise(resolve => { timeout = setTimeout(resolve, 15000); }),
  ]);
} catch {
  // Continue to the saved table when the update service is unavailable.
} finally {
  clearTimeout(timeout);
  location.replace(destination.href);
}
