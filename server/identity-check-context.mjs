import { IdentityFailure } from './auth.mjs';

const requestContexts = new WeakMap();
export function bindIdentityCheckContext(request, context) {
  if (!request || typeof request !== 'object' || requestContexts.has(request)) throw new TypeError('Identity request context already bound');
  context.assert(); requestContexts.set(request, context);
}
export function identityCheckContextFor(request) { return requestContexts.get(request); }
export function unbindIdentityCheckContext(request, context) {
  if (requestContexts.get(request) === context) requestContexts.delete(request);
}

// Wall-clock timestamps are signed for the central service. Only the monotonic
// clock decides the local budget; moving the clock cannot restart a check.
export function createIdentityCheckContext({ timeoutMs = 8000, queueMs = 4000,
  now = Date.now, monotonicNow = () => performance.now(), signal: parentSignal,
  scheduler = { setTimeout, clearTimeout } } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000
    || !Number.isInteger(queueMs) || queueMs < 1 || queueMs > 4000
    || typeof now !== 'function' || typeof monotonicNow !== 'function'
    || typeof scheduler?.setTimeout !== 'function' || typeof scheduler?.clearTimeout !== 'function'
    || parentSignal !== undefined && (typeof parentSignal?.aborted !== 'boolean'
      || typeof parentSignal.addEventListener !== 'function' || typeof parentSignal.removeEventListener !== 'function')) {
    throw new TypeError('Invalid identity check context');
  }
  const triggeredAtMs = now(), monotonicStart = monotonicNow();
  if (!Number.isSafeInteger(triggeredAtMs) || triggeredAtMs < 0 || !Number.isFinite(monotonicStart)
    || !Number.isSafeInteger(triggeredAtMs + timeoutMs)) throw new TypeError('Invalid identity check clock');
  const controller = new AbortController();
  let disposed = false, rejectExpired, budgetMs = timeoutMs;
  const expired = new Promise((_, reject) => { rejectExpired = reject; });
  expired.catch(() => {});
  const onAbort = () => rejectExpired(new IdentityFailure(503));
  const abort = () => controller.abort();
  controller.signal.addEventListener('abort', onAbort, { once: true });
  parentSignal?.addEventListener('abort', abort, { once: true });
  let timer = scheduler.setTimeout(abort, timeoutMs);
  if (parentSignal?.aborted) abort();
  const remainingMs = () => {
    const current = monotonicNow();
    if (!Number.isFinite(current) || current < monotonicStart) return 0;
    return Math.max(0, budgetMs - (current - monotonicStart));
  };
  const isLive = () => !disposed && !controller.signal.aborted && remainingMs() > 0;
  const assert = () => {
    if (!isLive()) { abort(); throw new IdentityFailure(503); }
  };
  const restrict = maximumMs => {
    if (!Number.isInteger(maximumMs) || maximumMs < 1 || maximumMs > 10000) throw new TypeError('Invalid identity budget');
    if (maximumMs >= budgetMs) { assert(); return; }
    budgetMs = maximumMs;
    scheduler.clearTimeout(timer);
    const remaining = remainingMs();
    if (remaining <= 0) abort();
    else timer = scheduler.setTimeout(abort, remaining);
    assert();
  };
  const wait = async operation => {
    assert();
    // Starting a function is delayed until its owner has asserted the original
    // fence. Cancellation rejects waiting; it does not claim remote completion.
    const result = await Promise.race([
      Promise.resolve().then(() => { assert(); return typeof operation === 'function' ? operation() : operation; }), expired,
    ]);
    assert();
    return result;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    scheduler.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
    // Any outstanding waiter becomes unusable even if its transport ignores
    // cancellation. That transport retains its own accounting until settlement.
    abort();
    controller.signal.removeEventListener('abort', onAbort);
  };
  return Object.freeze({ triggeredAtMs,
    get queueUntilMs() { return triggeredAtMs + Math.min(queueMs, budgetMs); },
    get deadlineMs() { return triggeredAtMs + budgetMs; },
    get validUntil() { return triggeredAtMs + budgetMs; },
    signal: controller.signal, assert, wait, remainingMs, isLive, restrict, dispose });
}
