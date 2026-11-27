import { createConnection, createServer } from 'node:net';
import { lstat, chmod, mkdir, unlink } from 'node:fs/promises';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { once } from 'node:events';

async function existing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function clearDeadSocket(path) {
  const initial = await existing(path);
  if (!initial) return;
  if (!initial.isSocket() || initial.uid !== process.getuid()) throw Error('Unrecognized control socket path');
  const probe = createConnection({ path });
  try {
    await once(probe, 'connect');
    throw Error('Another Noname control service is running');
  } catch (error) {
    if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') throw error;
  } finally { probe.destroy(); }
  const current = await existing(path);
  if (current && current.dev === initial.dev && current.ino === initial.ino) await unlink(path);
}

export async function startNonameControl({ bridge, path }) {
  if (!isAbsolute(path) || !bridge?.control) throw Error('Expected a local Noname control socket');
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
    throw Error('The Noname control directory must be private to the service user');
  }
  const flag = path + '.draining';
  const saved = await existing(flag);
  if (saved && (!saved.isFile() || saved.uid !== process.getuid())) throw Error('Unrecognized drain marker');
  if (saved) bridge.control('drain');
  await clearDeadSocket(path);
  const clients = new Set();
  const server = createServer(client => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.on('error', () => client.destroy());
    client.setTimeout(3000, () => client.destroy());
    let body = '';
    client.setEncoding('utf8');
    client.on('data', async chunk => {
      body += chunk;
      if (body.length > 256) return client.destroy();
      if (!body.includes('\n')) return;
      client.removeAllListeners('data');
      try {
        const request = JSON.parse(body);
        if (!request || Object.keys(request).length !== 1 || !['drain', 'status', 'resume', 'protection'].includes(request.op)) {
          throw Error('Invalid local operation');
        }
        // The durable marker and the in-process gate change in one event-loop
        // turn. A restarted relay must still reject new tables during rollout.
        if (request.op === 'drain') {
          try { closeSync(openSync(flag, 'wx', 0o600)); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        } else if (request.op === 'resume') {
          try { unlinkSync(flag); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        let result;
        if (request.op === 'protection') result = await bridge.protection();
        else {
          result = bridge.control(request.op);
          const state = await bridge.protection();
          result.openTables = Math.max(result.openTables, state.unfinishedTables ?? 0) + state.pendingAdmissions;
        }
        client.end(JSON.stringify({ok:true, ...result}) + '\n');
      } catch { client.end('{"ok":false}\n'); }
    });
  });
  const listening = once(server, 'listening');
  server.listen(path);
  await listening;
  try { await chmod(path, 0o600); }
  catch (error) { server.close(); throw error; }
  let stopping;
  return { stop() {
    if (!stopping) {
      for (const client of clients) client.destroy();
      stopping = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    return stopping;
  } };
}
