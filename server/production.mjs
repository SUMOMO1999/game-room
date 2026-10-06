import { DatabaseSync } from 'node:sqlite';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { readSettings } from './config.mjs';
import { createRuntime } from './runtime.mjs';
import { createUnifiedServer } from './unified-http.mjs';
import { verifyLiveStore } from './backup.mjs';

export function runtimeVersions() {
  const parts = process.versions.node.split('.').map(Number);
  if (parts[0] < 22 || (parts[0] === 22 && (parts[1] < 23 || (parts[1] === 23 && parts[2] < 2)))) throw new Error('Unsupported Node runtime');
  const db = new DatabaseSync(':memory:');
  let sqlite;
  try { sqlite = db.prepare('SELECT sqlite_version() AS version').get().version; } finally { db.close(); }
  const version = sqlite.split('.').map(Number);
  // The tested branch includes the upstream WAL-reset fix. Older backports require separate review.
  if (version[0] < 3 || (version[0] === 3 && (version[1] < 51 || (version[1] === 51 && version[2] < 3)))) throw new Error('SQLite WAL fix is required');
  return { node: process.versions.node, sqlite };
}
async function closeRuntime(runtime) {
  runtime.preview?.close();
  try { await runtime.chat?.close(); }
  finally { try { await runtime.rooms.close(); } finally { runtime.storage.close(); } }
}
export async function prepareProduction(env = process.env) {
  const versions = runtimeVersions();
  const settings = readSettings(env);
  if (!settings.production) throw new Error('Production entry requires NODE_ENV=production');
  const runtime = createRuntime(settings);
  let liveStoreValidation;
  try {
    const disk = statfsSync(dirname(settings.storePath));
    if (disk.bavail * disk.bsize < 256 * 1024 * 1024) throw new Error('Insufficient persistent disk space');
    await runtime.storage.adapter.get('health-check');
    liveStoreValidation = verifyLiveStore({ sourcePath: settings.storePath, key: settings.storeKey });
  } catch (error) { try { await closeRuntime(runtime); } finally { throw error; } }
  return { ...runtime, versions, liveStoreValidation };
}
export async function startProduction(env = process.env) {
  const runtime = await prepareProduction(env);
  let server;
  try {
    server = createUnifiedServer({ ...runtime, entries: runtime.settings.entries });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(runtime.settings.port, runtime.settings.host, resolve); });
  } catch (error) {
    try { if (server) await server.shutdown(); else await closeRuntime(runtime); }
    finally { throw error; }
  }
  return { server, ...runtime };
}
