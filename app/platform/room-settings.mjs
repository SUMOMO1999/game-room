// Settings owns only its panel and event lifecycle. Audio, rules, room business
// controls and device preferences retain their original nodes and owners.
export function mountRoomSettings({ document, buttonId, dialogId, controlIds = [],
  closeButtonId = null, dismissIds = [], containerId = null } = {}) {
  const byId = id => document?.getElementById(id);
  const button = byId(buttonId), dialog = byId(dialogId);
  if (!button || !dialog || typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function') {
    throw new TypeError('设置需要独立的入口和弹层。');
  }
  const removers = [], placements = [];
  const dismissed = new Set(dismissIds);
  const definitions = controlIds.map(definition => {
    const item = typeof definition === 'string' ? { id: definition } : definition;
    const targetId = item?.containerId || containerId;
    const control = byId(item?.id), target = targetId ? byId(targetId) : dialog;
    if (!control || control === dialog || control === button || !target || control.contains?.(target)) {
      throw new TypeError('设置条目需要有效且独立的原控件。');
    }
    if (item.dismiss) dismissed.add(item.id);
    return { control, target };
  });
  const dismissControls = [...dismissed].map(id => {
    const control = byId(id);
    if (!control) throw new TypeError('设置跳转条目不存在。');
    return control;
  });
  let destroyed = false, returnFocus = true;
  function listen(target, type, callback, options) {
    target?.addEventListener(type, callback, options);
    removers.push(() => target?.removeEventListener(type, callback, options));
  }
  function expanded() { button.setAttribute('aria-expanded', String(dialog.open)); }
  function close({ restoreFocus = true } = {}) {
    if (destroyed) return;
    returnFocus = restoreFocus;
    if (dialog.open) dialog.close();
    expanded();
  }
  function open() {
    if (destroyed || button.disabled || document.hidden) return;
    returnFocus = true;
    if (!dialog.open) dialog.showModal();
    expanded();
  }
  button.classList.add('game-settings-toggle'); dialog.classList.add('game-settings-dialog');
  button.setAttribute('aria-controls', dialogId); button.setAttribute('aria-haspopup', 'dialog'); expanded();
  for (const { control, target } of definitions) {
    placements.push({ control, parent: control.parentElement, next: control.nextSibling });
    target.append(control);
  }
  // Capture always runs before the control's existing rules/confirmation
  // handler, independent of which page module mounted first.
  for (const control of dismissControls) {
    listen(control, 'click', () => close({ restoreFocus: false }), { capture: true });
  }
  listen(button, 'click', () => dialog.open ? close() : open());
  listen(byId(closeButtonId), 'click', () => close());
  listen(dialog, 'cancel', event => { event.preventDefault(); close(); });
  listen(dialog, 'keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  listen(dialog, 'close', () => {
    expanded();
    if (returnFocus && !document.querySelector?.('dialog[open]')) button.focus?.({ preventScroll: true });
  });
  listen(document, 'visibilitychange', () => { if (document.hidden) close({ restoreFocus: false }); });
  listen(document.defaultView, 'pagehide', () => close({ restoreFocus: false }));
  return { open, close, destroy() {
    if (destroyed) return;
    close({ restoreFocus: false }); destroyed = true; removers.forEach(remove => remove());
    for (const { control, parent, next } of [...placements].reverse()) {
      if (!parent) continue;
      if (next?.parentElement === parent && parent.insertBefore) parent.insertBefore(control, next);
      else parent.append(control);
    }
  } };
}

// HTML is the assembly boundary; each game declares its controls and destinations
// without a game-type branch or a duplicate settings implementation.
export function mountDocumentRoomSettings(document) {
  return [...document.querySelectorAll('[data-room-settings]')].map(button => mountRoomSettings({
    document, buttonId: button.id, dialogId: button.dataset.settingsDialog,
    closeButtonId: button.dataset.settingsClose,
    controlIds: [...document.querySelectorAll('[data-settings-target]')].map(control => ({
      id: control.id, containerId: control.dataset.settingsTarget, dismiss: control.hasAttribute('data-settings-dismiss'),
    })),
  }));
}
if (typeof document !== 'undefined' && document.querySelectorAll) mountDocumentRoomSettings(document);
