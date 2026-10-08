import { prepareProduction, closeRuntime } from '../server/production.mjs';

process.umask(0o077);
try {
  const runtime = await prepareProduction();
  try {
    console.log(JSON.stringify({ ok: true, origin: runtime.settings.origin, callback: runtime.settings.callback,
      postLogout: runtime.settings.postLogout, versions: runtime.versions, storeReady: true, clientConfigured: true,
      identityBatchConfigured: runtime.settings.identityBatchEnabled,
      poker414Enabled: runtime.poker414Enabled,
      onlineClientValidation: 'pending-joint-acceptance' }));
  } finally { await closeRuntime(runtime); }
} catch (error) { console.error(`Preflight failed: ${error.message}`); process.exitCode = 1; }
