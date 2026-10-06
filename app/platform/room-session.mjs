// Page-owned fences supplement RoomClient's request/stream epochs. They cover
// room bootstrap, callbacks, and page finally blocks without changing identity.
export function createRoomSession({ document, accountGeneration, accountState, getClient } = {}) {
  let sequence = 0, pending = null, destroyed = false;
  const capture = (...sources) => ({ sequence, account: accountGeneration(), ...(sources.length ? { source: sources[0] } : {}) });
  function current(fence, { account = true, verified = true, visible = true } = {}) {
    return !destroyed && fence.sequence === sequence && !fence.controller?.signal.aborted
      && (!account || fence.account === accountGeneration())
      && (!verified || accountState().verification === 'verified')
      && (!visible || !document.hidden)
      && (!Object.hasOwn(fence, 'source') || fence.source === getClient());
  }
  function invalidate() {
    ++sequence;
    const previous = pending; pending = null;
    previous?.controller.abort();
  }
  function bootstrap(prepare, run) {
    if (destroyed) return Promise.resolve();
    if (pending && current(pending, { verified: false, visible: false })) return pending.promise;
    invalidate(); prepare();
    const task = { sequence, account: accountGeneration(), controller: new AbortController(), promise: null };
    pending = task;
    // Schedule after assigning promise so an immediate clear/retry can always
    // observe the same pending task. A retired finally never unlocks its successor.
    task.promise = Promise.resolve().then(() => {
      if (current(task, { verified: false, visible: false })) return run(task);
    }).finally(() => { if (pending === task) pending = null; });
    return task.promise;
  }
  function destroy() { invalidate(); destroyed = true; }
  return { capture, current, invalidate, bootstrap, destroy };
}

// Explicit leave is a business write. Unknown outcomes keep the exact request
// body for the next user-confirmed retry; no transport error replays it itself.
export function createRoomExit({ session, roomCode, getClient, getView, forgetMembership,
  onPending, onFailure, onLeft, requireAcknowledgement = false,
  requestId = () => crypto.randomUUID() } = {}) {
  let pending = null, active = null;
  function reset() { pending = null; active = null; }
  function run() {
    if (active && session.current(active.fence)) return active.promise;
    const client = getClient(), view = getView();
    if (!client || !view) return Promise.resolve(false);
    const task = { fence: session.capture(client), promise: null };
    if (!session.current(task.fence)) return Promise.resolve(false);
    active = task;
    pending ||= { type:'leave', requestId:requestId(), expectedRevision:view.revision };
    const body = pending, selfId = view.selfId;
    onPending?.();
    task.promise = (async () => {
      try {
        const result = await client.request(`/api/rooms/${roomCode}/actions`, {
          method:'POST', token:client.membership.token, body,
        }, client.epoch());
        if (!session.current(task.fence)) return false;
        if (requireAcknowledgement && result?.left !== true) throw new Error('退出结果暂时无法确认，请重试。');
        client.stop(); forgetMembership(roomCode,selfId); onLeft?.(); return true;
      } catch (error) {
        if (!session.current(task.fence)) return false;
        if ([400,403,409].includes(error.status)) pending = null;
        onFailure?.(error);
        if (session.current(task.fence)) client.connect();
        return false;
      } finally { if (active === task) active = null; }
    })();
    return task.promise;
  }
  return { run, reset };
}
