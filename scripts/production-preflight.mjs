import { prepareProduction } from '../server/production.mjs';

process.umask(0o077);
try {
  const runtime = await prepareProduction();
  try {
    console.log(JSON.stringify({ ok: true, origin: runtime.settings.origin, callback: runtime.settings.callback,
      postLogout: runtime.settings.postLogout, versions: runtime.versions, storeReady: true, clientConfigured: true,
      onlineClientValidation: 'pending-joint-acceptance' }));
  } finally { runtime.preview?.close();await runtime.chat?.close(); await runtime.rooms.close(); runtime.storage.close(); }
} catch (error) { console.error(`Preflight failed: ${error.message}`); process.exitCode = 1; }
