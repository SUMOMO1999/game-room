// All entries share gesture activation; labels and the older Rummikub restore
// preference stay explicit at the call site.
export function mountRoomAudioControls({ audio, document, onLabel = '音效开', offLabel = '音效关',
  restoreWhenUnready = false } = {}) {
  const node = id => document.getElementById(id), toggle = node('sound-toggle'), volume = node('sound-volume');
  const listeners = [];
  let restoreRequested = false, destroyed = false;
  function listen(target, type, handler, options) {
    target?.addEventListener(type, handler, options);
    listeners.push(() => target?.removeEventListener(type, handler, options));
  }
  function update() {
    if (destroyed) return;
    const state = audio.state();
    if (toggle) {
      toggle.textContent = state.muted || !state.supported ? offLabel : state.ready ? onLabel : '点按启声';
      toggle.setAttribute('aria-pressed', String(!state.muted && state.ready));
      toggle.setAttribute('aria-label', state.muted ? '开启音效' : state.ready ? '关闭音效' : '点按恢复音效');
      toggle.disabled = !state.supported;
    }
    if (volume) volume.value = String(Math.round(state.volume * 100));
  }
  const unsubscribe = audio.onStateChange?.(update);
  // Touch activation is granted on release; repeated handlers share unlock().
  for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'keydown']) {
    listen(document, type, event => {
      if (destroyed || !event.isTrusted) return;
      const state = audio.state();
      if (event.target?.closest?.('#sound-toggle')) restoreRequested ||= state.needsGesture || restoreWhenUnready && !state.ready;
      audio.unlock().then(update).catch(() => {});
    }, { capture: true });
  }
  listen(toggle, 'click', () => {
    if (destroyed) return;
    const state = audio.state();
    audio.setMuted(state.muted || restoreRequested ? false : state.ready); restoreRequested = false; update();
    if (!audio.state().muted) audio.unlock().then(() => {
      if (destroyed) return;
      audio.play('placement', { gesture: true }); update();
    }).catch(update);
  });
  listen(volume, 'input', event => audio.setVolume(Number(event.target.value) / 100));
  const unbindPreview = audio.bindPreview?.({ select: node('sound-preview-kind'), button: node('sound-preview'), status: node('sound-preview-status') });
  update();
  function destroy() {
    if (destroyed) return;
    destroyed = true; listeners.forEach(remove => remove()); unsubscribe?.(); unbindPreview?.();
  }
  return { update, destroy };
}
