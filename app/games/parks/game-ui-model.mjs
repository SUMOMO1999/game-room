/** Ephemeral choices only. Costs, legality, randomness and ownership come from view. */
export function parksViewScope(room) {
  const game = room?.game;
  return JSON.stringify([room?.roomId, room?.selfId, room?.selfRole, room?.phase,
    game?.matchId, game?.window?.id, game?.window?.responsibleSeatId]);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const actionIdentity = action => JSON.stringify(canonical({ type: action?.type, fields: action?.fields, cost: action?.cost, result: action?.result }));

export function createParksDraft() {
  let scope = null, action = null, overrides = {};
  return {
    sync(room) {
      const next = parksViewScope(room);
      if (scope !== next) { action = null; overrides = {}; }
      scope = next;
      // A same-window authoritative update can invalidate the selected object or price.
      if (action) {
        const current = room?.game?.legalActions?.find(value => actionIdentity(value) === actionIdentity(action));
        action = current && !current.disabledReason ? structuredClone(current) : null;
        if (!action) overrides = {};
      }
      return this.current();
    },
    select(value, room) {
      this.sync(room);
      const actual = room?.game?.legalActions?.find(item => actionIdentity(item) === actionIdentity(value));
      if (!actual || actual.disabledReason) return false;
      action = structuredClone(actual); overrides = {}; return true;
    },
    choosePayment(vector) {
      if (!action?.cost?.paymentOptions?.some(value => JSON.stringify(canonical(value)) === JSON.stringify(canonical(vector)))) return false;
      const key = action.type === 'discard-resources' ? 'resources' : 'payment';
      if (!Object.hasOwn(action.fields, key)) return false;
      overrides[key] = structuredClone(vector); return true;
    },
    current() {
      if (!action) return null;
      const current = { ...structuredClone(action), fields: { ...structuredClone(action.fields), ...structuredClone(overrides) } };
      const payment = current.fields.payment || current.fields.resources;
      const quote = payment && action.cost?.paymentQuotes?.find(value => JSON.stringify(canonical(value.payment)) === JSON.stringify(canonical(payment)));
      if (quote) { current.result = structuredClone(quote.result); current.cost.remainingResources = structuredClone(quote.remainingResources); if (quote.remainingPhotos !== undefined) current.cost.remainingPhotos = quote.remainingPhotos; }
      return current;
    },
    isSelected(value) { return Boolean(action && actionIdentity(action) === actionIdentity(value)); },
    cancel() { action = null; overrides = {}; },
    clear() { scope = null; action = null; overrides = {}; },
  };
}

/** Display countdown only; receipt/reconnect never extends the server window. */
export function createParksDisplayClock() {
  let key = null, remaining = null, receivedAt = 0, paused = false;
  const read = now => remaining === null ? null : Math.max(0, remaining - (paused ? 0 : Math.max(0, now - receivedAt)));
  return {
    update(game, now) {
      const next = `${game?.matchId}:${game?.window?.id}`;
      const amount = game?.practice || !Number.isFinite(game?.window?.remainingMs) ? null : Math.max(0, game.window.remainingMs);
      const nextPaused = Boolean(game?.window?.paused);
      const elapsed = read(now);
      remaining = next === key && nextPaused === paused && amount !== null && elapsed !== null ? Math.min(amount, elapsed) : amount;
      key = next; paused = nextPaused; receivedAt = now;
    },
    read,
    clear() { key = null; remaining = null; receivedAt = 0; paused = false; },
  };
}

export function parksCommand(game, type, fields = {}) {
  if (!game?.matchId || !game.window?.id) throw new Error('这一步已结束，请以当前桌面为准。');
  if (fields.type !== undefined && fields.type !== type) throw new Error('操作与当前选择不一致。');
  if (fields.matchId !== undefined && fields.matchId !== game.matchId
    || fields.windowId !== undefined && fields.windowId !== game.window.id) throw new Error('这一步已过期，请重新选择。');
  const opportunityId = fields.opportunityId ?? null;
  if (opportunityId !== null && !game.opportunities?.some(value => value.id === opportunityId && value.status === 'open')) {
    throw new Error('这次收益已经处理完毕，请查看当前桌面。');
  }
  return { ...structuredClone(fields), type, matchId: game.matchId,
    windowId: game.window.id, opportunityId };
}

export function parksStageProfiles() {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  // Touch landscape uses its own composition and retains physical target sizes.
  return [
    { id: 'mobile-landscape', match: v => v.width <= 1100 && v.height < 560,
      width: v => Math.max(620, v.width), height: v => Math.max(320, v.height), scale: false },
    { id: 'compact-desktop', match: v => v.height < 640,
      width: v => clamp(v.width, 1100, 1600), height: v => clamp(v.height, 570, 630) },
    { id: 'ultrawide-desktop', match: v => v.width / v.height >= 2.4 && v.width >= 1680,
      width: v => clamp(v.width, 1680, 2400), height: v => clamp(v.height, 680, 1000) },
    { id: 'classic-desktop', match: v => v.width / v.height < 1.7,
      width: v => clamp(v.width, 1024, 1280), height: v => clamp(v.height, 700, 1000) },
    { id: 'desktop', match: () => true,
      width: v => clamp(v.width, 1280, 1680), height: v => clamp(v.height, 680, 1000) },
  ];
}
