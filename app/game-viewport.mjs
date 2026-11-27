// Fixed game canvas geometry. Visual offsets are relevant only while editing or
// zooming; WebKit may retain a stale keyboard/rotation offset at normal scale.
export function gameViewport({width,height,visual,editing=false}={}) {
  const positive=(value,fallback)=>Number.isFinite(value) && value>0?value:fallback;
  const w=positive(width,1),h=positive(height,1),scale=positive(visual?.scale,1);
  const zoomed=Math.abs(scale-1)>.025;
  const staleWidth=!zoomed && Math.abs(positive(visual?.width,w)-w)>Math.max(4,w*.1);
  const vw=staleWidth?w:positive(visual?.width,w),vh=staleWidth?h:positive(visual?.height,h);
  const offset=value=>Number.isFinite(value)?Math.max(0,value):0;
  return {width:vw,height:vh,top:editing || zoomed?offset(visual?.offsetTop):0,
    left:editing || zoomed?offset(visual?.offsetLeft):0,resetScroll:!editing && !zoomed};
}

const editingField = 'textarea,select,[contenteditable]:not([contenteditable="false"]),' +
  'input:not([type="button"],[type="submit"],[type="checkbox"],[type="radio"],[type="range"],[type="reset"])';

// Only documents that host a game mount this guard. The browser may pan a
// fixed viewport even when there is no document scroll range (notably iOS).
// Keep touch events available to the game and allow real inner scroll areas.
export function mountFixedGameDocument(win) {
  const doc = win?.document;
  const root = doc?.documentElement;
  if (!root?.style?.getPropertyValue || !doc.body || !win.getComputedStyle) return () => {};
  const style = root.style;
  const saved = ['overflow', 'overscroll-behavior'].map(name =>
    [name, style.getPropertyValue(name), style.getPropertyPriority?.(name) ?? '']);
  style.setProperty('overflow', win.CSS?.supports?.('overflow', 'clip') ? 'clip' : 'hidden');
  style.setProperty('overscroll-behavior', 'none');
  let touch;

  function pin() {
    if (!doc.activeElement?.matches(editingField) && Math.abs((win.visualViewport?.scale ?? 1) - 1) < .025 &&
        (win.scrollX || win.scrollY)) win.scrollTo(0, 0);
  }
  function start(event) {
    const path = event.composedPath();
    const point = event.touches[0];
    touch = event.touches.length === 1 && !path.some(node => node.matches?.(editingField))
      ? { id: point.identifier, x: point.clientX, y: point.clientY, path } : null;
  }
  function move(event) {
    if (!touch || event.touches.length !== 1 || event.touches[0].identifier !== touch.id ||
        !event.cancelable || Math.abs((win.visualViewport?.scale ?? 1) - 1) >= .025) return;
    const { clientX: x, clientY: y } = event.touches[0];
    const dx = x - touch.x, dy = y - touch.y;
    if (!touch.scrollAreas && Math.max(Math.abs(dx), Math.abs(dy)) < 5) return;
    touch.x = x;
    touch.y = y;
    if (!dx && !dy) return;
    if (!touch.scrollAreas) {
      touch.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      const overflow = touch.axis === 'x' ? 'overflowX' : 'overflowY';
      touch.scrollAreas = touch.path.filter(node => node.nodeType === 1 && node !== root && node !== doc.body &&
        /^(auto|scroll|overlay)$/.test(win.getComputedStyle(node)[overflow]));
    }
    const horizontal = touch.axis === 'x', delta = horizontal ? dx : dy;
    if (!delta) return;
    const scrolls = touch.scrollAreas.some(node => {
      const position = horizontal ? Math.abs(node.scrollLeft) : node.scrollTop;
      const max = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
      if (max <= 1) return false;
      const towardStart = horizontal && win.getComputedStyle(node).direction === 'rtl' ? delta < 0 : delta > 0;
      return towardStart ? position > .5 : position < max - .5;
    });
    if (!scrolls) event.preventDefault();
  }
  const touchScreen = win.navigator?.maxTouchPoints > 0 || 'ontouchstart' in win;
  if (touchScreen) {
    doc.addEventListener('touchstart', start, { capture: true, passive: true });
    doc.addEventListener('touchmove', move, { capture: true, passive: false });
  }
  win.addEventListener('scroll', pin, { passive: true });
  win.addEventListener('pageshow', pin);
  pin();
  return () => {
    doc.removeEventListener('touchstart', start, true);
    doc.removeEventListener('touchmove', move, true);
    win.removeEventListener('scroll', pin);
    win.removeEventListener('pageshow', pin);
    for (const [name, value, priority] of saved) {
      if (value) style.setProperty(name, value, priority);
      else style.removeProperty(name);
    }
  };
}

// An installed iOS app can publish its final dimensions after its last resize
// event. Check briefly after rotations and wake-ups, while the table stays live.
export function watchStandaloneRotation(win) {
  const doc = win.document;
  const ios = /iPad|iPhone|iPod/.test(win.navigator.userAgent) ||
    (win.navigator.platform === 'MacIntel' && win.navigator.maxTouchPoints > 1);
  if (!ios || win.top !== win || !win.visualViewport ||
      !(win.navigator.standalone || win.matchMedia('(display-mode: standalone)').matches ||
        win.matchMedia('(display-mode: fullscreen)').matches)) return;

  const visual = win.visualViewport;
  const root = doc.documentElement;
  const heightProperty = '--room-standalone-height';
  let pending = [], notice, hintTimer, gapSince, hinted = false, notifying = false;
  let affectedWindow, viewportProbe, viewportObserver;
  let notifiedWidth = win.innerWidth, notifiedHeight = win.innerHeight;

  function clearHint() {
    win.clearTimeout(hintTimer);
    notice?.remove();
    notice = undefined;
  }

  function placeHint() {
    const header = doc.querySelector('header');
    const box = notice.getBoundingClientRect();
    const controls = [...doc.querySelectorAll('button,a,input,select,textarea,[role="button"],[tabindex],header img,header svg')];
    const blocks = controls.filter(el => !notice.contains(el)).map(el => el.getBoundingClientRect());
    if (header) {
      const words = doc.createTreeWalker(header, win.NodeFilter.SHOW_TEXT);
      const range = doc.createRange();
      while (words.nextNode()) {
        if (!words.currentNode.textContent.trim()) continue;
        range.selectNodeContents(words.currentNode);
        blocks.push(...range.getClientRects());
      }
    }
    const obstacles = blocks.filter(b => b.width && b.top < box.bottom && b.bottom > box.top);
    let best = .5, leastOverlap = Infinity;
    for (const fraction of [.5, .25, .75, .18, .82]) {
      const half = box.width / 2;
      const center = Math.max(half + 6, Math.min(win.innerWidth - half - 6, win.innerWidth * fraction));
      const left = center - half, right = center + half;
      const overlap = obstacles.reduce((sum, b) => sum + Math.max(0, Math.min(right, b.right + 4) - Math.max(left, b.left - 4)), 0);
      if (overlap < leastOverlap) { best = center / win.innerWidth; leastOverlap = overlap; }
      if (overlap === 0) break;
    }
    notice.style.left = (best * 100) + '%';
    return leastOverlap === 0;
  }

  function showHint() {
    notice = doc.createElement('span');
    notice.dataset.roomRotationNotice = '';
    notice.setAttribute('role', 'status');
    notice.textContent = '顶部留白时，可转到另一侧横屏';
    const slot = doc.querySelector('[data-room-rotation-slot]');
    const inToolbar = slot && slot.parentElement.getClientRects().length > 0;
    if (inToolbar) {
      // The native board contains private cards and player labels in an iframe.
      // Its existing voice toolbar has space for a message without covering play.
      slot.append(notice);
    } else {
      notice.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:max(4px,env(safe-area-inset-top));transform:translateX(-50%);width:max-content;max-width:80%;box-sizing:border-box;padding:4px 8px;border-radius:8px;background:#242421ed;color:white;font:14px/1.4 system-ui;text-align:center;pointer-events:none';
      if (doc.fullscreenEnabled && root.requestFullscreen && !doc.fullscreenElement) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = '试用全屏';
        button.style.cssText = 'margin-inline-start:8px;min-height:32px;padding:0 8px;border:1px solid currentColor;border-radius:5px;background:transparent;color:white;font:inherit;pointer-events:auto';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await root.requestFullscreen(); }
          catch { button.remove(); }
          checkAfterChange();
        });
        notice.append(button);
      }
      doc.body.append(notice);
      // On crowded tables the tap-through text alone leaves every game action usable.
      if (!placeHint() && notice.querySelector('button')) {
        notice.querySelector('button').remove();
        placeHint();
      }
    }
    hinted = true;
    hintTimer = win.setTimeout(clearHint, 7500);
  }

  function observeViewport() {
    if (viewportProbe || !doc.body || !win.ResizeObserver) return;
    // Dynamic units stay independent of an explicitly sized game container
    // and of the outer iframe being turned sideways while holding a table.
    viewportProbe = doc.createElement('div');
    viewportProbe.setAttribute('aria-hidden', 'true');
    viewportProbe.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;width:100dvw;height:100dvh;visibility:hidden;pointer-events:none;contain:strict';
    doc.body.append(viewportProbe);
    viewportObserver = new win.ResizeObserver(checkAfterChange);
    viewportObserver.observe(viewportProbe);
  }

  function sample() {
    if (doc.hidden) return;
    observeViewport();
    const width = win.innerWidth, height = win.innerHeight;
    const editing = doc.activeElement?.matches(editingField);
    const settled = !editing && width > 0 && height > 0 &&
      Math.abs(visual.scale - 1) < .025 && Math.abs(visual.offsetTop) < 2 && Math.abs(visual.offsetLeft) < 2 &&
      Math.abs(visual.width - width) < 2 && Math.abs(visual.height - height) < 2;
    const landscape = settled && width > height && win.outerWidth > win.outerHeight;
    // Use only the drawable area. A matching reservation on both axes is
    // the signature observed on the expanded Duo. The cover screen fills normally.
    const side = win.outerWidth - width, top = win.outerHeight - height;
    const doubleInset = landscape && win.outerHeight >= 600 && side >= 45 && side <= win.outerWidth * .15 &&
      top >= 45 && top <= win.outerHeight * .18 && Math.abs(side - top) <= 8;
    if (doubleInset) affectedWindow = { long: win.outerWidth, short: win.outerHeight };
    const sameWindow = affectedWindow &&
      Math.abs(Math.max(win.outerWidth, win.outerHeight) - affectedWindow.long) <= 2 &&
      Math.abs(Math.min(win.outerWidth, win.outerHeight) - affectedWindow.short) <= 2;
    if (sameWindow && landscape) root.style.setProperty(heightProperty, height + 'px');
    else if (root.style.getPropertyValue(heightProperty)) root.style.removeProperty(heightProperty);
    if (doubleInset) {
      gapSince ??= win.performance.now();
      if (!hinted && win.performance.now() - gapSince >= 650 && doc.body) showHint();
    } else {
      gapSince = undefined;
      hinted = false;
      clearHint();
    }

    if (settled && (notifiedWidth !== width || notifiedHeight !== height)) {
      notifiedWidth = width;
      notifiedHeight = height;
      notifying = true;
      try { win.dispatchEvent(new win.Event('resize')); }
      finally { notifying = false; }
    }
  }

  function cancelChecks() {
    pending.forEach(id => win.clearTimeout(id));
    pending = [];
  }
  function stopObservingViewport() {
    viewportObserver?.disconnect();
    viewportProbe?.remove();
    viewportObserver = viewportProbe = undefined;
  }
  function checkAfterChange() {
    cancelChecks();
    if (!doc.hidden) pending = [0, 120, 400, 800, 1500, 2800].map(ms => win.setTimeout(sample, ms));
  }
  function onResize() {
    if (notifying) return;
    notifiedWidth = win.innerWidth;
    notifiedHeight = win.innerHeight;
    checkAfterChange();
  }
  function onHide() {
    cancelChecks();
    stopObservingViewport();
    clearHint();
    gapSince = undefined;
    hinted = false;
  }
  win.addEventListener('resize', onResize);
  win.addEventListener('orientationchange', checkAfterChange);
  win.screen.orientation?.addEventListener('change', checkAfterChange);
  visual.addEventListener('resize', checkAfterChange);
  visual.addEventListener('scroll', checkAfterChange);
  doc.addEventListener('visibilitychange', () => doc.hidden ? onHide() : checkAfterChange());
  doc.addEventListener('focusin', checkAfterChange);
  doc.addEventListener('focusout', checkAfterChange);
  win.addEventListener('pagehide', onHide);
  win.addEventListener('pageshow', checkAfterChange);
  win.addEventListener('focus', checkAfterChange);
  doc.addEventListener('fullscreenchange', checkAfterChange);
  checkAfterChange();
}

if (typeof window !== 'undefined') watchStandaloneRotation(window);
