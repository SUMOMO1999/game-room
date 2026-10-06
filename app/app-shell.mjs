import { entryBase } from './entry-path.mjs';
/** Shared installation and display controls; independent from seat/game state. */
export function isStandalone(browser) {
  return Boolean(browser.navigator?.standalone || browser.matchMedia?.('(display-mode: standalone)').matches);
}
export function installationSteps(device = {}) {
  const ua = device.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
    || (device.platform === 'MacIntel' && device.maxTouchPoints > 1);
  if (isIOS) return {
    label: 'iPhone / iPad',
    steps: ['在 Safari 打开棋牌室，点浏览器的分享按钮。', '选择「添加到主屏幕」；如有「作为 Web App 打开」，请开启，然后点「添加」。', '以后从主屏幕上的棋牌室图标进入，游戏时把手机横过来。'],
  };
  if (/Android/i.test(ua)) return {
    label: '安卓 · Chrome',
    steps: ['在 Chrome 打开棋牌室，点右上角菜单。', '选择「安装应用」或「添加到主屏幕」，按提示确认。', '以后从棋牌室图标进入，游戏时把手机横过来。'],
  };
  return {
    label: '电脑 / 其他设备',
    steps: ['Chrome 可在地址栏或浏览器菜单中选择「安装棋牌室」或「安装应用」。', 'Mac 上的 Safari 可在「文件」菜单中选择「添加到程序坞」。', '手机可在 Safari 的分享菜单，或安卓 Chrome 的菜单中添加到主屏幕。'],
  };
}
export async function toggleFullscreen(documentRef) {
  try {
    if (documentRef.fullscreenElement) {
      await documentRef.exitFullscreen();
      return { ok: true, active: false };
    }
    if (!documentRef.fullscreenEnabled || !documentRef.documentElement?.requestFullscreen) {
      return { ok: false, message: '这台设备暂不支持页面全屏，可以先放到手机桌面，再从桌面图标打开。' };
    }
    await documentRef.documentElement.requestFullscreen();
    return { ok: true, active: true };
  } catch {
    return { ok: false, message: '暂时无法进入全屏。可以继续在当前窗口玩，或下次先放到手机桌面，再从桌面图标开局。' };
  }
}

function initializeShell() {
  const header = document.querySelector('.site-header');
  if (entryBase() === '/game/' && header && !document.querySelector('#back-to-agora')) {
    const link = document.createElement('a');
    link.id = 'back-to-agora'; link.href = '/#projects'; link.textContent = '← 返回 Agora';
    // Use the existing room menu instead of crowding the fixed game header.
    const menu = document.querySelector('.room-menu-actions');
    link.className = menu ? 'secondary-button agora-entry-return' : 'quiet-link agora-entry-return';
    if (menu) menu.append(link); else if (document.querySelector('.lobby-shell')) header.after(link);
    for (const anchor of document.querySelectorAll('a.account-reauth-link')) {
      anchor.href = '/#account'; anchor.removeAttribute('target');
    }
  }
  if (!header || document.querySelector('#app-shell-tools')) return;
  const tools = document.createElement('div');
  tools.id = 'app-shell-tools'; tools.className = 'app-shell-tools';
  tools.setAttribute('aria-label', '应用显示方式');
  tools.innerHTML = '<button type="button" class="quiet-button app-shell-button" id="app-install">放到手机桌面</button><button type="button" class="quiet-button app-shell-button" id="app-fullscreen" hidden>全屏显示</button><p class="app-shell-status" id="app-display-status" role="status" aria-live="polite" hidden></p>';
  header.after(tools);
  const dialog = document.createElement('dialog');
  dialog.className = 'app-install-dialog'; dialog.id = 'app-install-dialog';
  dialog.setAttribute('aria-labelledby', 'app-install-title');
  dialog.innerHTML = '<div class="dialog-heading"><p class="eyebrow">ON YOUR HOME SCREEN</p><button type="button" class="close-button" aria-label="关闭安装说明" id="app-install-close">×</button></div><h2 id="app-install-title">从桌面，打开棋牌室。</h2><p class="app-install-intro">减少浏览器栏占用，留出更多牌桌空间。游戏时请横过手机；部分设备需要手动旋转，顶部时间和电量仍可能显示。</p><div class="dialog-tip"><strong>同一个账号，接着上一局</strong><p>换浏览器或从桌面图标进入后，登录同一账号即可恢复座位与已提交的牌局。尚未提交的牌桌整理只保留在原标签页，换入口前请先提交。</p></div><p class="app-install-device" id="app-install-device"></p><ol class="app-install-steps" id="app-install-steps"></ol><p class="app-install-note">朋友局需要保持联网。添加图标后，仍可继续在浏览器里打开。</p><p class="app-shell-status" id="app-install-status" role="status" aria-live="polite" hidden></p><button type="button" class="primary-button" id="app-install-native" hidden>安装到设备</button><button type="button" class="secondary-button app-install-done" id="app-install-done">明白了</button>';
  document.body.append(dialog);
  const install = tools.querySelector('#app-install');
  const full = tools.querySelector('#app-fullscreen');
  const displayStatus = tools.querySelector('#app-display-status');
  const nativeInstall = dialog.querySelector('#app-install-native');
  const installStatus = dialog.querySelector('#app-install-status');
  const guide = installationSteps(navigator);
  dialog.querySelector('#app-install-device').textContent = guide.label;
  for (const text of guide.steps) {
    const item = document.createElement('li'); item.textContent = text;
    dialog.querySelector('#app-install-steps').append(item);
  }
  let deferredPrompt = null;
  let installed = false;
  let displayTimer = null;
  function updateControls() {
    install.hidden = installed || isStandalone(window);
    full.hidden = !document.fullscreenEnabled || !document.documentElement.requestFullscreen;
    full.textContent = document.fullscreenElement ? '退出全屏' : '全屏显示';
    tools.hidden = install.hidden && full.hidden && displayStatus.hidden;
    nativeInstall.hidden = !deferredPrompt;
  }
  function closeDialog() {
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  }
  install.addEventListener('click', () => {
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  });
  dialog.querySelector('#app-install-close').addEventListener('click', closeDialog);
  dialog.querySelector('#app-install-done').addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); deferredPrompt = event; updateControls();
  });
  window.addEventListener('appinstalled', () => { installed = true; deferredPrompt = null; closeDialog(); updateControls(); });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', updateControls);
  nativeInstall.addEventListener('click', async () => {
    const prompt = deferredPrompt;
    if (!prompt) return;
    deferredPrompt = null; nativeInstall.hidden = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') { installed = true; closeDialog(); updateControls(); }
    } catch {
      installStatus.textContent = '暂时无法打开安装窗口，请按上面的步骤添加到主屏幕。';
      installStatus.hidden = false;
    }
  });
  full.addEventListener('click', async () => {
    clearTimeout(displayTimer);
    const result = await toggleFullscreen(document);
    displayStatus.textContent = result.ok ? (result.active ? '已进入全屏。' : '已退出全屏。') : result.message;
    displayStatus.hidden = false; updateControls();
    if (result.ok) displayTimer = setTimeout(() => { displayStatus.hidden = true; updateControls(); }, 3000);
  });
  document.addEventListener('fullscreenchange', updateControls);
  updateControls();
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch(() => {
      // Installation/display controls and online games remain usable without the worker.
    });
  }
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') initializeShell();
