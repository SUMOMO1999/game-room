import { restoreStore } from '../server/backup.mjs';
import { readStoreKey } from '../server/config.mjs';
try {
  const [sourcePath, destinationPath, confirmation, ...rest] = process.argv.slice(2);
  if (!sourcePath || !destinationPath || confirmation !== '--offline' || rest.length) throw new Error('Usage: store-restore.mjs ABSOLUTE_BACKUP ABSOLUTE_NEW_DATABASE --offline');
  const key = readStoreKey();
  if (!key) throw new Error('A stable server-only store key is required');
  console.log(JSON.stringify(restoreStore({ sourcePath, destinationPath, key, offline: true })));
} catch {
  console.error('Restore failed: stop the BFF, use a new destination, and verify the existing stable key and backup. No existing files were overwritten.');
  process.exitCode = 1;
}
