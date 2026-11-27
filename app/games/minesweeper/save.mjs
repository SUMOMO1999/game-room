export function openSaves() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sumomo-minesweeper-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('levels');
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new Error('本机存档不可用'));
  });
}

function withStore(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('levels', mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('交易已取消'));
    run(tx.objectStore('levels'), value => { result = value; });
  });
}

export function readLevel(db, level) {
  return withStore(db, 'readonly', (store, finish) => {
    const request = store.get(level);
    request.onsuccess = () => finish(request.result ?? {});
  });
}

function updateLevel(db, level, update) {
  return withStore(db, 'readwrite', (store, finish) => {
    const request = store.get(level);
    request.onsuccess = () => {
      const row = request.result ?? {};
      const next = update(row);
      if (next) store.put(next, level);
      finish(next);
    };
  });
}

export const assignOwner = (db, level, owner) => updateLevel(db, level, row => ({ ...row, owner }));

export function saveLevel(db, level, owner, expected, game, { award = false } = {}) {
  return updateLevel(db, level, row => {
    if (row.owner !== owner || row.game?.id !== expected?.id || row.game?.revision !== expected?.revision) return null;
    let best = row.best;
    if (award && game.phase === 'won' && game.clockOK && (!best || game.spent < best.seconds)) {
      best = { seconds: game.spent, date: game.ended };
    }
    return { ...row, game, best };
  });
}

// Locks auto-release on closing a tab. Persistent owner and revision checks
// fence a previous holder even during another tab's explicit takeover.
export function acquireLevel(level, takeOver, onLost) {
  if (!navigator.locks?.request) return Promise.reject(new Error('浏览器无法保护存档'));
  return new Promise((resolve, reject) => {
    const name = 'sumomo-minesweeper-v1:' + level;
    const options = takeOver ? { steal: true } : { ifAvailable: true };
    let acquired = false, release;
    navigator.locks.request(name, options, lock => {
      if (!lock) return resolve(null);
      acquired = true;
      return new Promise(done => {
        release = done;
        resolve({ release: () => release(), id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random() });
      });
    }).catch(error => acquired ? onLost() : reject(error));
  });
}

export function clearBests(db, levels) {
  return withStore(db, 'readwrite', (store) => {
    for (const level of levels) {
      const request = store.get(level);
      request.onsuccess = () => {
        if (request.result) store.put({ ...request.result, best: undefined }, level);
      };
    }
  });
}
