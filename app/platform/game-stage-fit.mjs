const dimensions = ['width', 'height'];

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0 || value > 32768) throw new RangeError(`Invalid game stage ${name}`);
  return value;
}

// Profiles belong to each game's composition. This module only fits display
// geometry; it never owns a game action, selected card or persisted coordinate.
export function fitGameStage({ width, height, profiles, minScale = .85, inputMode = 'fine' }) {
  positive(width, 'viewport width'); positive(height, 'viewport height');
  if (!Array.isArray(profiles) || !profiles.length || !Number.isFinite(minScale) || minScale <= 0 || minScale > 1)
    throw new TypeError('Game stage profiles and scale limit are required');
  const viewport = Object.freeze({ width, height, inputMode });
  const profile = profiles.find(candidate => candidate.match?.(viewport) ?? true);
  if (!profile || typeof profile.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(profile.id))
    throw new TypeError('No valid game stage profile matches the viewport');
  const logical = Object.fromEntries(dimensions.map(name => [name,
    positive(typeof profile[name] === 'function' ? profile[name](viewport) : profile[name], name)]));
  const scale = profile.scale === false ? 1 : Math.min(1, width / logical.width, height / logical.height);
  const unsupported = scale < minScale || logical.width * scale > width + .01 || logical.height * scale > height + .01;
  return Object.freeze({ profile: profile.id, width: logical.width, height: logical.height, scale,
    offsetX: Math.max(0, (width - logical.width * scale) / 2),
    offsetY: Math.max(0, (height - logical.height * scale) / 2),
    viewportWidth: width, viewportHeight: height, unsupported });
}

export function stagePointFromClient(fit, hostRect, { clientX, clientY }) {
  return { x: (clientX - hostRect.left - fit.offsetX) / fit.scale,
    y: (clientY - hostRect.top - fit.offsetY) / fit.scale };
}

export function mountGameStageFit({ host, stage, profiles, minScale = .85, onFit = () => {},
  window = globalThis.window } = {}) {
  if (!host?.getBoundingClientRect || !stage?.style || !window?.addEventListener)
    throw new TypeError('Game stage host, stage and window are required');
  const properties = ['width', 'height', 'transform', 'transform-origin', '--stage-scale', '--stage-width', '--stage-height'];
  const previous = properties.map(name => [name, stage.style.getPropertyValue(name), stage.style.getPropertyPriority(name)]);
  const originalProfile = stage.getAttribute('data-stage-profile');
  const originalHostProfile = host.getAttribute('data-stage-profile');
  let destroyed = false, frame = null, current = null, signature = '';
  function update() {
    if (destroyed) return current;
    const rect = host.getBoundingClientRect();
    const width = rect.width, height = rect.height;
    // Hidden preparation/portrait surfaces are fitted when measurable again.
    if (!(width > 0 && height > 0)) return current;
    const fit = fitGameStage({ width, height, profiles, minScale,
      inputMode: window.matchMedia?.('(pointer: coarse)').matches ? 'coarse' : 'fine' });
    const next = JSON.stringify(fit);
    if (next === signature) return current;
    signature = next; current = fit;
    stage.style.setProperty('width', `${fit.width}px`);
    stage.style.setProperty('height', `${fit.height}px`);
    stage.style.setProperty('transform-origin', '0 0');
    stage.style.setProperty('transform', `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`);
    stage.style.setProperty('--stage-scale', String(fit.scale));
    stage.style.setProperty('--stage-width', `${fit.width}px`);
    stage.style.setProperty('--stage-height', `${fit.height}px`);
    stage.setAttribute('data-stage-profile', fit.profile); host.setAttribute('data-stage-profile', fit.profile);
    onFit(fit);
    return fit;
  }
  function schedule() {
    if (destroyed || frame !== null) return;
    if (!window.requestAnimationFrame) { update(); return; }
    frame = window.requestAnimationFrame(() => { frame = null; update(); });
  }
  const observer = window.ResizeObserver ? new window.ResizeObserver(schedule) : null;
  observer?.observe(host);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  update();
  return { update, getFit: () => current, destroy() {
    if (destroyed) return;
    destroyed = true; observer?.disconnect();
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    if (frame !== null) window.cancelAnimationFrame?.(frame);
    frame = null;
    for (const [name, value, priority] of previous) value ? stage.style.setProperty(name, value, priority) : stage.style.removeProperty(name);
    for (const [node, value] of [[stage, originalProfile], [host, originalHostProfile]])
      value === null ? node.removeAttribute('data-stage-profile') : node.setAttribute('data-stage-profile', value);
  } };
}
