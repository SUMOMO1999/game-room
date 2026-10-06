import { startProduction } from '../server/production.mjs';

process.umask(0o077);
try {
  const { server, settings } = await startProduction();
  console.log(`棋牌室 ready: ${settings.origin}`);
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { console.error('棋牌室 shutdown deadline exceeded'); process.exit(1); }, 15000);
    deadline.unref();
    try { await server.shutdown(); clearTimeout(deadline); }
    catch { console.error('棋牌室 shutdown failed'); process.exitCode = 1; }
  });
  server.on('error', () => { console.error('棋牌室 HTTP server failed'); process.exitCode = 1; });
} catch {
  // Never dump environment, credentials or provider error payloads to logs.
  console.error('棋牌室 production startup failed; run protected preflight');
  process.exitCode = 1;
}
