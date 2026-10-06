// Explicit practice exit replaces only the current history entry. Saving and
// suspension remain with the practice page's existing lifecycle controller.
export function replacePracticeWithLobby(location) {
  if (typeof location?.replace !== 'function') throw new TypeError('练习退出需要当前页面导航。');
  location.replace('./');
}

export function mountPracticeExit({ document, location } = {}) {
  const controls = [...document?.querySelectorAll('[data-practice-exit], [data-practice-mode]') ?? []];
  const removers = controls.map(control => {
    const click = event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (control.hasAttribute('data-practice-exit')) {
        event.preventDefault(); replacePracticeWithLobby(location); return;
      }
      // A course switch stays within this practice page; arbitrary navigation
      // and all browser gestures keep their normal history semantics.
      let current, target;
      try { current = new URL(location.href); target = new URL(control.href, current); } catch { return; }
      if (target.origin !== current.origin || target.pathname !== current.pathname) return;
      event.preventDefault(); location.replace(target.href);
    };
    control.addEventListener('click', click);
    return () => control.removeEventListener('click', click);
  });
  return () => removers.forEach(remove => remove());
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountPracticeExit({ document, location: window.location });
}
