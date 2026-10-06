// One unresolved business intent per member/room. This is a local recovery
// record, never a credential or proof of success. Only an owning server receipt
// or a definite response resolves it; a different room revision does not.
const copy = value => structuredClone(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function validBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body) && id(body.requestId)
    && typeof body.type === 'string' && /^[a-z][a-z-]*$/.test(body.type)
    && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0;
}
export function createRoomActionIntent({ scope, storage, key, requestId = () => crypto.randomUUID() }) {
  if (!scope || !id(scope.roomId) || !id(scope.memberId) || !id(scope.owner) || typeof key !== 'string') throw new TypeError('操作所属房间无效。');
  let pending = null;
  let storageReady = !!storage && ['getItem', 'setItem', 'removeItem'].every(method => typeof storage[method] === 'function');
  try {
    const saved = JSON.parse(storageReady ? storage.getItem(key) || 'null' : 'null');
    if (saved?.version === 1 && JSON.stringify(saved.scope) === JSON.stringify(scope) && validBody(saved.body)) pending = copy(saved.body);
  } catch { storageReady = false; /* Never overwrite a pending request we could not read. */ }
  function clear() { pending = null; try { storage?.removeItem(key); } catch { /* A later owning receipt safely resolves a retained record again. */ } }
  function begin(type, fields, view) {
    if (!storageReady) throw Object.assign(new Error('无法保存本次操作，请允许本站存储后重新进入房间。'), { code: 'INTENT_STORAGE_UNAVAILABLE' });
    if (pending) throw Object.assign(new Error('上一操作尚未确认，请先恢复结果。'), { code: 'ACTION_UNCONFIRMED' });
    const body = { ...copy(fields), type, requestId: requestId(), expectedRevision: view.revision };
    if (!validBody(body) || JSON.stringify(body).length > 8192) throw new TypeError('操作格式无效。');
    // Save before POST. When browser storage denies a write, no operation is sent.
    storage.setItem(key, JSON.stringify({ version: 1, scope, body })); pending = body;
    return copy(body);
  }
  function reconcile(view) {
    if (!pending || (view?.roomId || view?.roomCode) !== scope.roomId || view?.selfId !== scope.memberId) return null;
    const receipt = view.actionReceipts?.find(entry => entry.requestId === pending.requestId);
    if (!receipt || !['committed', 'rejected'].includes(receipt.status)) return null;
    const result = copy(receipt); clear(); return result;
  }
  return { begin, reconcile, clear, available: () => storageReady, pending: () => copy(pending),
    retry: () => { if (!pending) throw new Error('没有待确认的操作。'); return copy(pending); } };
}
