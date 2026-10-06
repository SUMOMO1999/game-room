import { backupStore, verifyBackup } from '../server/backup.mjs';
import { readStoreKey } from '../server/config.mjs';
try {
  const args = process.argv.slice(2);
  const key = readStoreKey();
  if (!key) throw new Error('A stable server-only store key is required');
  if (args.length === 2 && args[0] === '--verify') {
    const { manifest } = verifyBackup({ sourcePath: args[1], key });
    console.log(JSON.stringify({ verified: true, ...manifest }));
  } else if (args.length === 1 && process.env.GAME_ROOM_STORE_PATH) {
    console.log(JSON.stringify(await backupStore({ sourcePath: process.env.GAME_ROOM_STORE_PATH,
      destinationPath: args[0], key })));
  } else throw new Error('Usage: store-backup.mjs ABSOLUTE_DESTINATION or --verify ABSOLUTE_BACKUP');
} catch {
  console.error('Backup failed: check paths, stable key, database integrity and ownership. No existing files were overwritten.');
  process.exitCode = 1;
}
