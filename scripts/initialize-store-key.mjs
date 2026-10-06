import { randomBytes } from 'node:crypto';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

try {
  const [file, ...rest] = process.argv.slice(2);
  if (!file || rest.length || !isAbsolute(file)) throw new Error();
  // Exclusive creation only: never rotate the existing database encryption key implicitly.
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, randomBytes(32).toString('base64url') + '\n'); } finally { closeSync(fd); }
  console.log('Stable store key created in protected file. Preserve a separate private recovery copy.');
} catch { console.error('Key initialization refused: use a new absolute owner-only path. Existing keys were not changed.'); process.exitCode = 1; }
