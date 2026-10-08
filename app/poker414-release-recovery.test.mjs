import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease } from '../scripts/build-release.mjs';

test('complete release restores schema11 and permanent scores in new processes with 414 creation disabled', { timeout: 60000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), '414-package-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const descriptorPath = process.env.GAME_ROOM_414_ROLLBACK_DESCRIPTOR;
  const descriptor = descriptorPath ? JSON.parse(readFileSync(descriptorPath, 'utf8')).application
    : buildRelease({ outputRoot: join(directory, 'artifacts') });
  assert.equal(createHash('sha256').update(readFileSync(descriptor.artifact)).digest('hex'), descriptor.sha256);
  const packageRoot = join(directory, 'release'); mkdirSync(packageRoot);
  const members = execFileSync('tar', ['-tzf', descriptor.artifact], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(members.every(file => /^[A-Za-z0-9_./-]+$/.test(file) && !file.startsWith('/') && !file.split('/').includes('..')));
  execFileSync('tar', ['-xzf', descriptor.artifact, '-C', packageRoot]);
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.releaseId, descriptor.releaseId); assert.equal(manifest.sourceFiles.length, descriptor.files);
  assert.deepEqual(new Set(members), new Set([...manifest.sourceFiles.map(entry => entry.file), 'release-manifest.json']));
  for (const entry of manifest.sourceFiles) assert.equal(createHash('sha256').update(readFileSync(join(packageRoot, entry.file))).digest('hex'), entry.sha256);
  for (const file of ['app/poker414.html', 'app/games/poker414-2/game-page.mjs', 'server/game-scores.mjs',
    'server/backup.mjs', 'scripts/store-restore.mjs', 'scripts/production-start.mjs']) assert.ok(members.includes(file), file);
  const worker = fileURLToPath(new URL('./test-support/poker414-release-recovery-worker.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, GAME_ROOM_STORE_KEY_FILE: join(directory, 'synthetic.key') };
  function run(file, args) {
    const result = spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout);
  }
  const seeded = run(worker, [packageRoot, directory, 'seed']);
  assert.equal(seeded.completedLedgers, 2);
  const backup = join(directory, 'business-backup.sqlite'), restored = join(directory, 'restored.sqlite');
  const verified = run(join(packageRoot, 'scripts/store-backup.mjs'), ['--verify', backup]);
  assert.equal(verified.verified, true); assert.equal(verified.scoresIncluded, true); assert.equal(verified.scopes.length, 16);
  const result = run(join(packageRoot, 'scripts/store-restore.mjs'), [backup, restored, '--offline']);
  assert.equal(result.authSessionsRestored, false); assert.equal(result.scoresIncluded, true);
  const first = run(worker, [packageRoot, directory, 'restore']);
  const second = run(worker, [packageRoot, directory, 'restart']);
  assert.deepEqual(first.totals, seeded.totals); assert.deepEqual(second.totals, seeded.totals);
  assert.equal(first.ledgerCount, 4); assert.equal(second.ledgerCount, 4);
  const rejected = spawnSync(process.execPath, [join(packageRoot, 'scripts/store-restore.mjs'), backup, restored, '--offline'],
    { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /No existing files were overwritten/);
  t.diagnostic(JSON.stringify({ releaseId: descriptor.releaseId, sha256: descriptor.sha256, files: descriptor.files,
    seed: seeded, restore: first, secondRestart: second, refusesExistingDestination: true }));
});
