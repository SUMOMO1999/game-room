// One private Unix connection owns one referee. Replies and native output can
// travel independently while a command is waiting for the original game loop.
export function localRpc(socket, dispatch) {
  let sequence = 0;
  const pending = new Map();
  socket.on('message', async raw => {
    try {
      const [kind, id, method, args] = JSON.parse(raw.toString());
      if (!Number.isSafeInteger(id) || id < 1) return socket.terminate();
      if (kind === 'ok' || kind === 'failed') {
        const call = pending.get(id);
        if (!call) return socket.terminate();
        pending.delete(id);
        clearTimeout(call.timer);
        if (kind === 'ok') call.resolve(method);
        else call.reject(Error('Private table service could not complete '+call.method));
      } else if (kind === 'call' && typeof method === 'string' && Array.isArray(args)) {
        let reply;
        try { reply = ['ok',id,await dispatch(method,args)]; }
        catch { reply = ['failed',id]; }
        if (socket.readyState === 1) socket.send(JSON.stringify(reply));
      } else socket.terminate();
    } catch { socket.terminate(); }
  });
  socket.on('error', () => socket.terminate());
  socket.once('close', () => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('Private table connection closed')); }
    pending.clear();
  });
  return function request(method, ...args) {
    if (socket.readyState !== 1 || pending.size >= 4096) return Promise.reject(Error('Private table connection unavailable'));
    const id = ++sequence;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => socket.terminate(), method === 'open' ? 150000 : 60000);
      timer.unref();
      pending.set(id,{resolve,reject,timer,method});
      socket.send(JSON.stringify(['call',id,method,args]),error => { if (error) socket.terminate(); });
    });
  };
}

