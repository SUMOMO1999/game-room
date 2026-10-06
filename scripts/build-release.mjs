import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_DATA_COMPATIBILITY, validateDataCompatibility } from './release-compatibility.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
export const PACKAGING_FORMAT = 2;
export function releaseSources(projectRoot = root) {
  const files = ['package.json', 'package-lock.json'];
  function walk(relative) {
    for (const name of readdirSync(join(projectRoot, relative)).sort()) {
      const file = join(relative, name), stat = lstatSync(join(projectRoot, file));
      if (stat.isSymbolicLink()) throw new Error('Release source cannot be a symbolic link');
      if (stat.isDirectory()) {
        if (!['test-support', 'tests', 'fixtures', '__tests__', '__fixtures__'].includes(name)) walk(file);
      }
      else if (stat.isFile() && /\.(?:html|css|mjs|js|svg|png|webmanifest)$/.test(name) && !name.endsWith('.test.mjs') && !(relative === 'app' && name === 'server.mjs')) files.push(file);
    }
  }
  walk('app'); walk('server');
  for (const script of ['production-start.mjs','production-preflight.mjs','initialize-store-key.mjs','store-backup.mjs','store-restore.mjs','scheduled-backup.mjs','release-compatibility.mjs']) files.push(`scripts/${script}`);
  for (const file of ['Caddyfile','game-room.service','game-room-backup.service','game-room-backup.timer','runtime.env.example','install-release.sh','activate-release.sh']) files.push(`infra/${file}`);
  return files.sort();
}
export function buildRelease({ projectRoot = root, outputRoot = join(root, 'dist') } = {}) {
  const sources = releaseSources(projectRoot);
  const entries = sources.map(file => ({ file, sha256: hash(readFileSync(join(projectRoot, file))) }));
  const releaseId = hash(JSON.stringify({ packagingFormat: PACKAGING_FORMAT, sourceFiles: entries })).slice(0, 20);
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const output = join(outputRoot, `game-room-${releaseId}.tar.gz`);
  if (existsSync(output)) throw new Error('Release artifact already exists; refusing to overwrite');
  const staging = mkdtempSync(join(outputRoot, '.release-'));
  try {
    for (const entry of entries) {
      const target = join(staging, entry.file); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(projectRoot, entry.file)), { mode: 0o644 });
    }
    const manifest = { format: 1, packagingFormat: PACKAGING_FORMAT, project: 'game-room', releaseId, sourceFiles: entries,
      identity: 'dedicated-client-required', identityPolicy: 'agora-account-security-v1', containsSecrets: false, containsUserData: false,
      dataCompatibility: validateDataCompatibility(CURRENT_DATA_COMPATIBILITY) };
    writeFileSync(join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    // macOS tar otherwise synthesizes AppleDouble members and PAX xattrs that
    // Linux's strict installer correctly treats as undeclared content.
    const metadataOptions = ['--no-xattrs', '--no-acls', ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-fflags'] : [])];
    execFileSync('tar', [...metadataOptions, '-czf', output, '-C', staging, ...sources, 'release-manifest.json'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    }); chmodSync(output, 0o600);
    const sha256 = hash(readFileSync(output));
    writeFileSync(`${output}.sha256`, `${sha256}  ${output.split('/').pop()}\n`, { flag: 'wx', mode: 0o600 });
    return { releaseId, artifact: output, sha256, files: entries.length };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(buildRelease())); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
