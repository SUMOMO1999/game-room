import { registerMerchantTable } from './mount.mjs';

const root = document.getElementById('hyakki-digital-root');
const styles = Array.from(document.querySelectorAll('link[data-arena-style]'));
try {
  const [{ openArena }, { mountMerchantDesk }] = await Promise.all([import('./native.mjs'), import('./merchant-arena.mjs')]);
  await openArena();
  await Promise.all(styles.map(sheet => new Promise((resolve, reject) => {
    sheet.addEventListener('load', resolve, { once:true });
    sheet.addEventListener('error', reject, { once:true });
    sheet.media = 'all';
    if (sheet.sheet) resolve();
  })));
  document.body.classList.add('merchant-table');
  registerMerchantTable(mountMerchantDesk);
} catch (error) {
  // Keep the existing table and its real seat available if the new renderer could not start.
  for (const sheet of styles) sheet.media = 'not all';
  console.error('商人牌桌未能初始化', error);
  document.querySelector('#window.merchant-window')?.remove();
}
if (root.dataset.entry === 'practice') await import('../practice-page.mjs');
else await import('../game-page.mjs');
