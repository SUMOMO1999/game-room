import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease } from './build-release.mjs';

// Build the source under test in an owned temporary directory. A fresh clone
// needs neither production descriptors nor credentials, databases or ops files.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.slice(2).includes('--release');
if (process.argv.slice(2).some(argument => argument !== '--release')) {
  console.error('Usage: node scripts/test.mjs [--release]');
  process.exit(1);
}
if (release) {
  const binary = process.env.GAME_ROOM_TEST_CADDY, expected = process.env.GAME_ROOM_TEST_CADDY_SHA256;
  if (!binary || !/^[a-f0-9]{64}$/.test(expected || '')) {
    console.error('Release verification requires GAME_ROOM_TEST_CADDY and its explicit GAME_ROOM_TEST_CADDY_SHA256.');
    process.exit(1);
  }
  if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== expected) {
    console.error('Caddy checksum mismatch; refusing to execute the binary.');
    process.exit(1);
  }
}
function discoverTests(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = join(directory, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Test discovery cannot follow symbolic links.');
    if (stat.isDirectory()) return ['node_modules', 'test-support', 'fixtures', '__fixtures__'].includes(name) ? [] : discoverTests(file);
    return stat.isFile() && name.endsWith('.test.mjs') ? [file] : [];
  });
}

const directory = mkdtempSync(join(tmpdir(), 'game-room-source-test-'));
chmodSync(directory, 0o700);
let child;
const relay = signal => child?.kill(signal);
const signals = ['SIGINT', 'SIGTERM'];
const handlers = signals.map(signal => [signal, () => relay(signal)]);
try {
  const application = buildRelease({ projectRoot, outputRoot: join(directory, 'artifacts') });
  const descriptor = join(directory, 'candidate.json');
  const emptyAwsConfig = join(directory, 'empty-aws-config');
  writeFileSync(descriptor, JSON.stringify({ application }) + '\n', { mode: 0o600 });
  writeFileSync(emptyAwsConfig, '', { mode: 0o600 });
  const env = { GAME_ROOM_SMOKE_DESCRIPTOR: descriptor, AWS_CONFIG_FILE: emptyAwsConfig,
    AWS_SHARED_CREDENTIALS_FILE: emptyAwsConfig, AWS_EC2_METADATA_DISABLED: 'true' };
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'GAME_ROOM_TEST_CADDY',
    'GAME_ROOM_TEST_CADDY_SHA256', 'OPENSSL_TEST_BINARY']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (release) env.GAME_ROOM_SMOKE_INSTALL = 'locked';
  const tests = discoverTests(join(projectRoot, 'app'));
  let tail = '';
  child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...tests],
    { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    tail = (tail + chunk.toString()).slice(-65536);
  });
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const [code, signal] = await new Promise((accept, reject) => {
    child.once('error', reject);
    // 'close' follows stdout/stderr completion; 'exit' may precede the TAP summary.
    child.once('close', (code, signal) => accept([code, signal]));
  });
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(label => {
    const matches = [...tail.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
    return [label, matches.length ? Number(matches.at(-1)[1]) : null];
  }));
  const complete = Object.values(counts).every(value => value !== null)
    && counts.tests > 0 && counts.pass === counts.tests
    && ['fail', 'cancelled', 'skipped', 'todo'].every(label => counts[label] === 0);
  if (release && !complete) console.error('Release verification requires a complete summary with zero failures, cancellations, skips and todo.');
  process.exitCode = signal ? 1 : code || (release && !complete ? 1 : 0);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const [signal, handler] of handlers) process.off(signal, handler);
  rmSync(directory, { recursive: true, force: true });
}
