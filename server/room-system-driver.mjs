/** Internal saved-cursor driver. No HTTP input can invoke a system step. */
export function createRoomSystemDriver({ advance, schedule = setImmediate, cancel = clearImmediate, maxSteps = 16 } = {}) {
  if (typeof advance !== 'function' || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 16) throw new TypeError('Invalid system driver.');
  const flights = new Map(), queued = new Map();
  let closed = false;
  function wake(roomId) {
    if (closed) return Promise.resolve(false);
    if (flights.has(roomId)) return flights.get(roomId);
    if (queued.has(roomId)) { cancel(queued.get(roomId)); queued.delete(roomId); }
    let more = false;
    const flight = (async () => {
      // Attempts, including CAS conflicts, share this bounded budget. Every
      // attempt reads fresh authority; an unknown result throws and is never replayed here.
      for (let count = 0; !closed && count < maxSteps; count++) {
        more = await advance(roomId);
        if (!more) return false;
      }
      return more;
    })().then(result => {
      if (result && !closed) queued.set(roomId,schedule(() => {
        queued.delete(roomId); wake(roomId).catch(() => {});
      }));
      return result;
    }).finally(() => flights.delete(roomId));
    flights.set(roomId,flight);
    return flight;
  }
  async function close() {
    closed = true;
    for (const handle of queued.values()) cancel(handle);
    queued.clear();
    await Promise.allSettled([...flights.values()]);
  }
  return {wake,close};
}
