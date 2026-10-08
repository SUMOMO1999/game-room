import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CURRENT_DATA_COMPATIBILITY, validateDataCompatibility, compareReleaseCompatibility, activationPolicy } from '../scripts/release-compatibility.mjs';
import { buildRelease } from '../scripts/build-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidateId = 'a'.repeat(20), priorId = 'b'.repeat(20);
const copy = (value) => structuredClone(value);
function manifest(id, capabilities) {
  return { format: 1, packagingFormat: 2, project: 'game-room', releaseId: id,
    containsSecrets: false, containsUserData: false,
    ...(capabilities === undefined ? {} : { dataCompatibility: copy(capabilities) }) };
}
const current = () => copy(CURRENT_DATA_COMPATIBILITY);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function fixture(t, { candidate = current(), prior, initial = false, healthFails = true, startFails = false, backupFails = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'game-activation-guard-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gameRoot = join(directory, 'game-room'), config = join(directory, 'config');
  const candidateDir = join(gameRoot, 'releases', candidateId), priorDir = join(gameRoot, 'releases', priorId);
  mkdirSync(join(candidateDir, 'scripts'), { recursive: true }); mkdirSync(priorDir, { recursive: true }); mkdirSync(config);
  copyFileSync(join(root, 'scripts/release-compatibility.mjs'), join(candidateDir, 'scripts/release-compatibility.mjs'));
  const candidateManifest = join(candidateDir, 'release-manifest.json'), priorManifest = join(priorDir, 'release-manifest.json');
  writeFileSync(candidateManifest, JSON.stringify(manifest(candidateId, candidate)));
  writeFileSync(priorManifest, JSON.stringify(manifest(priorId, prior)));
  writeFileSync(join(config, 'runtime.env'), '# synthetic runtime only\n'); writeFileSync(join(config, 'store-key'), 'synthetic-placeholder-not-a-real-key\n');
  const link = join(gameRoot, 'current'), database = join(directory, 'synthetic-database-marker'), log = join(directory, 'commands.log');
  writeFileSync(database, 'prior-data-retained'); writeFileSync(log, '');
  if (!initial) symlinkSync(priorDir, link);
  // Execute the actual shell control flow. Only absolute filesystem roots and
  // the Node executable are relocated; Linux-only tools and systemd are fakes.
  const original = readFileSync(join(root, 'infra/activate-release.sh'), 'utf8');
  const script = original.replaceAll('/opt/game-room', gameRoot).replaceAll('/etc/game-room', config).replaceAll('/opt/node/bin/node', process.execPath);
  const scriptPath = join(directory, 'activate-release.sh'), shellEnvironment = join(directory, 'shell-environment.sh');
  writeFileSync(scriptPath, script);
  writeFileSync(shellEnvironment, `
id() { printf '0\\n'; }
stat() { printf '0\\n'; }
readlink() { ${quote(process.execPath)} -e "try { process.stdout.write(require('node:fs').realpathSync(process.argv[1])); } catch {}" "$2"; }
mv() { [ "$1" = '-Tf' ] || return 99; ${quote(process.execPath)} -e "require('node:fs').renameSync(process.argv[1],process.argv[2]);" "$2" "$3"; }
systemd-run() { printf 'preflight\\n' >> ${quote(log)}; }
backup_invocation=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
systemctl() {
  local current operation=$1 unit="\${@: -1}"; current=$(readlink -f ${quote(link)})
  if [ "$operation" = show ]; then
    [ "$#" = 5 ] && [ "$2" = --property=ActiveState ] && [ "$3" = --property=InvocationID ] && [ "$4" = --property=Result ] && [ "$unit" = game-room-backup.service ] || return 99
    printf 'ActiveState=inactive\\nInvocationID=%s\\nResult=success\\n' "$backup_invocation"
    return 0
  fi
  printf '%s %s %s\\n' "$operation" "$unit" "$current" >> ${quote(log)}
  if [ "$operation" = start ] && [ "$unit" = game-room-backup.service ]; then
    [ "$#" = 3 ] && [ "$2" = --no-block ] || return 99
    if [ '${Number(backupFails)}' = 1 ]; then return 1; fi
    # This compatibility fixture completes a distinct backup immediately.
    # Running, activating, failure and timeout lifecycles use the dedicated
    # actual-shell production-activation-order fixture instead.
    backup_invocation=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  fi
  if [ "$operation" = start ] && [ "$unit" = game-room.service ] && [ "$current" = ${quote(candidateDir)} ]; then
    printf 'candidate-data-retained' > ${quote(database)}
    if [ '${Number(startFails)}' = 1 ]; then return 1; fi
  fi
  return 0
}
curl() { printf 'health\\n' >> ${quote(log)}; [ '${Number(healthFails)}' = 0 ]; }
`);
  return { directory, candidateDir, priorDir, candidateManifest, priorManifest, database, log, link,
    run() { return spawnSync('/bin/bash', [scriptPath, candidateId], { encoding: 'utf8',
      env: { ...process.env, BASH_ENV: shellEnvironment }, timeout: 10000 }); },
    commands() { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } };
}

test('declaration conservatively forbids schema2/nine-scope rollback to undeclared legacy schema1/six-scope code', () => {
  const result = compareReleaseCompatibility(manifest(candidateId, current()), manifest(priorId));
  assert.deepEqual(result, { forwardCompatible: true, rollbackCompatible: false, initial: false, priorLegacy: true });
  const same = compareReleaseCompatibility(manifest(candidateId, current()), manifest(priorId, current()));
  assert.equal(same.rollbackCompatible, true); assert.equal(same.forwardCompatible, true);
});

test('schema3 military snapshots prohibit rollback to the current schema2 Rummikub release', (t) => {
  const prior=current();prior.roomSnapshots={read:[1,2],write:[2]};
  const f=fixture(t,{prior});
  assert.equal(activationPolicy(f.candidateManifest,f.priorManifest),'rollback-forbidden');
  const failure=f.run();assert.equal(failure.status,1);assert.match(failure.stderr,/AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.equal(realpathSync(f.link),f.candidateDir);
  assert.ok(!f.commands().includes(`start game-room.service ${f.priorDir}`));
  assert.equal(compareReleaseCompatibility(manifest(candidateId,prior),manifest(priorId,current())).forwardCompatible,false);
});

test('schema5 flag transport cannot roll back to schema4 even when both releases enforce the same identity policy', t => {
  const prior = current(); prior.roomSnapshots = { read: [1, 2, 3, 4], write: [2, 3, 4] };
  const f = fixture(t, { prior }), identityPolicy = 'agora-account-security-v1';
  writeFileSync(f.candidateManifest, JSON.stringify({ ...manifest(candidateId, current()), identityPolicy }));
  writeFileSync(f.priorManifest, JSON.stringify({ ...manifest(priorId, prior), identityPolicy }));
  assert.deepEqual(compareReleaseCompatibility(JSON.parse(readFileSync(f.candidateManifest)), JSON.parse(readFileSync(f.priorManifest))),
    { forwardCompatible: true, rollbackCompatible: false, initial: false, priorLegacy: false });
  assert.equal(activationPolicy(f.candidateManifest, f.priorManifest), 'rollback-forbidden');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.equal(realpathSync(f.link), f.candidateDir);
  assert.ok(!f.commands().includes(`start game-room.service ${f.priorDir}`));
});

test('schema6 sacrifice games forbid rollback to the released schema5 transport engine', t => {
  const prior = current(); prior.roomSnapshots = { read: [1, 2, 3, 4, 5], write: [2, 3, 4, 5] };
  const f = fixture(t, { prior }), identityPolicy = 'agora-account-security-v1';
  writeFileSync(f.candidateManifest, JSON.stringify({ ...manifest(candidateId, current()), identityPolicy }));
  writeFileSync(f.priorManifest, JSON.stringify({ ...manifest(priorId, prior), identityPolicy }));
  assert.equal(activationPolicy(f.candidateManifest, f.priorManifest), 'rollback-forbidden');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.equal(realpathSync(f.link), f.candidateDir); assert.equal(readFileSync(f.database, 'utf8'), 'candidate-data-retained');
  assert.ok(!f.commands().includes(`start game-room.service ${f.priorDir}`));
});

test('schema9 unhealthy activation never starts the prior schema8 code or rolls the database back', t => {
  const prior = current(); prior.roomSnapshots = { read: [1, 2, 3, 4, 5, 6, 7, 8], write: [2, 3, 4, 5, 6, 7, 8] };
  const f = fixture(t, { prior }), identityPolicy = 'agora-account-security-v1';
  writeFileSync(f.candidateManifest, JSON.stringify({ ...manifest(candidateId, current()), identityPolicy }));
  writeFileSync(f.priorManifest, JSON.stringify({ ...manifest(priorId, prior), identityPolicy }));
  assert.equal(activationPolicy(f.candidateManifest, f.priorManifest), 'rollback-forbidden');
  const failure = f.run(); assert.equal(failure.status, 1); assert.match(failure.stderr, /AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.equal(realpathSync(f.link), f.candidateDir); assert.equal(readFileSync(f.database, 'utf8'), 'candidate-data-retained');
  assert.ok(!f.commands().includes(`start game-room.service ${f.priorDir}`));
});

test('attempting schema8 code against a schema9 prior stops before preflight, backup, service or current changes', t => {
  const old = current(); old.roomSnapshots = { read: [1, 2, 3, 4, 5, 6, 7, 8], write: [2, 3, 4, 5, 6, 7, 8] };
  const f = fixture(t, { candidate: old, prior: current() }), identityPolicy = 'agora-account-security-v1';
  writeFileSync(f.candidateManifest, JSON.stringify({ ...manifest(candidateId, old), identityPolicy }));
  writeFileSync(f.priorManifest, JSON.stringify({ ...manifest(priorId, current()), identityPolicy }));
  assert.throws(() => activationPolicy(f.candidateManifest, f.priorManifest), /CANDIDATE_DATA_INCOMPATIBLE/);
  const failure = f.run(); assert.equal(failure.status, 1); assert.match(failure.stderr, /Data compatibility declaration rejected/);
  assert.deepEqual(f.commands(), []); assert.equal(realpathSync(f.link), f.priorDir);
  assert.equal(readFileSync(f.database, 'utf8'), 'prior-data-retained');
});

test('schema4 settings and observer snapshots forbid rollback to schema3 despite identical E3 enforcement',t=>{
  const prior=current();prior.roomSnapshots={read:[1,2,3],write:[2,3]};
  const f=fixture(t,{prior}),identityPolicy='agora-account-security-v1';
  writeFileSync(f.candidateManifest,JSON.stringify({...manifest(candidateId,current()),identityPolicy}));
  writeFileSync(f.priorManifest,JSON.stringify({...manifest(priorId,prior),identityPolicy}));
  assert.deepEqual(compareReleaseCompatibility(JSON.parse(readFileSync(f.candidateManifest)),JSON.parse(readFileSync(f.priorManifest))),
    {forwardCompatible:true,rollbackCompatible:false,initial:false,priorLegacy:false});
  assert.equal(activationPolicy(f.candidateManifest,f.priorManifest),'rollback-forbidden');
  const failure=f.run();assert.equal(failure.status,1);assert.match(failure.stderr,/AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.equal(realpathSync(f.link),f.candidateDir);assert.equal(readFileSync(f.database,'utf8'),'candidate-data-retained');
  assert.ok(!f.commands().includes(`start game-room.service ${f.priorDir}`));
});

test('missing, malformed, unknown-format and self-inconsistent candidate declarations fail closed', () => {
  assert.throws(() => compareReleaseCompatibility(manifest(candidateId)), /candidate declaration/);
  const malformed = [null, {}, { ...current(), format: 2 }, { ...current(), unexpected: true },
    { ...current(), roomSnapshots: { read: [1], write: [2] } },
    { ...current(), roomSnapshots: { read: [1, 1, 2], write: [2] } },
    { ...current(), backupScopes: { read: ['rooms'], write: ['rooms', 'room-chat'] } },
    { ...current(), backupScopes: { read: ['../escape'], write: ['../escape'] } }];
  for (const value of malformed) assert.throws(() => validateDataCompatibility(value), /DATA_COMPATIBILITY_INVALID/);
  assert.throws(() => compareReleaseCompatibility(manifest(candidateId, current()), manifest(priorId, null)), /DATA_COMPATIBILITY_INVALID/);
});

test('forward data incompatibility is rejected before touching services or the current link', (t) => {
  const older = current(); older.roomSnapshots = { read: [1], write: [1] };
  const f = fixture(t, { candidate: older, prior: current() }), result = f.run();
  assert.equal(result.status, 1); assert.match(result.stderr, /CANDIDATE_DATA_INCOMPATIBLE/);
  assert.deepEqual(f.commands(), []); assert.equal(realpathSync(f.link), f.priorDir);
  assert.equal(readFileSync(f.database, 'utf8'), 'prior-data-retained');
});

test('actual unhealthy activation of incompatible data stops service, retains candidate link and data, and never starts prior code', (t) => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.equal(realpathSync(f.link), f.candidateDir);
  assert.equal(readFileSync(f.database, 'utf8'), 'candidate-data-retained');
  const commands = f.commands(); assert.equal(commands.filter((line) => line.startsWith('start game-room.service ')).length, 1);
  assert.ok(commands.at(-1).startsWith('stop game-room.service '));
  assert.ok(!commands.includes(`start game-room.service ${f.priorDir}`));
});

test('actual candidate start failure also forbids incompatible automatic rollback', (t) => {
  const f = fixture(t, { startFails: true }), result = f.run();
  assert.equal(result.status, 1); assert.match(result.stderr, /AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.equal(realpathSync(f.link), f.candidateDir); assert.ok(!f.commands().includes('health'));
  assert.ok(!f.commands().includes(`start game-room.service ${f.priorDir}`));
});

test('actual compatible unhealthy activation restores prior code while preserving database', (t) => {
  const f = fixture(t, { prior: current() }), result = f.run();
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /prior code restored/);
  assert.equal(realpathSync(f.link), f.priorDir);
  assert.equal(readFileSync(f.database, 'utf8'), 'candidate-data-retained');
  assert.equal(f.commands().at(-1), `start game-room.service ${f.priorDir}`);
});

test('shared identity enforcement cannot silently roll back or downgrade despite compatible game data',t=>{
  const f=fixture(t,{prior:current()});
  const candidate={...manifest(candidateId,current()),identityPolicy:'agora-account-security-v1'};
  writeFileSync(f.candidateManifest,JSON.stringify(candidate));
  assert.equal(activationPolicy(f.candidateManifest,f.priorManifest),'rollback-forbidden');
  const failure=f.run();assert.equal(failure.status,1);assert.match(failure.stderr,/AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.equal(realpathSync(f.link),f.candidateDir);
  assert.ok(!f.commands().includes(`start game-room.service ${f.priorDir}`));
  writeFileSync(f.priorManifest,JSON.stringify({...manifest(priorId,current()),identityPolicy:'agora-account-security-v1'}));
  assert.equal(activationPolicy(f.candidateManifest,f.priorManifest),'rollback-allowed');
  writeFileSync(f.candidateManifest,JSON.stringify(manifest(candidateId,current())));
  assert.throws(()=>activationPolicy(f.candidateManifest,f.priorManifest),/CANDIDATE_IDENTITY_POLICY_DOWNGRADE/);
  writeFileSync(f.candidateManifest,JSON.stringify({...candidate,identityPolicy:'unknown'}));
  assert.throws(()=>activationPolicy(f.candidateManifest,f.priorManifest),/unknown identity policy/);
});

test('malformed prior or candidate declaration leaves prior service and data untouched', (t) => {
  for (const options of [{ candidate: null }, { prior: null }]) {
    const f = fixture(t, options), result = f.run();
    assert.equal(result.status, 1); assert.match(result.stderr, /Data compatibility declaration rejected/);
    assert.deepEqual(f.commands(), []); assert.equal(realpathSync(f.link), f.priorDir);
    assert.equal(readFileSync(f.database, 'utf8'), 'prior-data-retained');
  }
});

test('symlink or damaged manifest cannot supply a trusted compatibility policy', (t) => {
  const f = fixture(t);
  writeFileSync(f.candidateManifest, '{malformed'); assert.throws(() => activationPolicy(f.candidateManifest, f.priorManifest));
  const regular = join(f.directory, 'regular-manifest.json'); writeFileSync(regular, JSON.stringify(manifest(candidateId, current())));
  rmSync(f.candidateManifest); symlinkSync(regular, f.candidateManifest);
  assert.throws(() => activationPolicy(f.candidateManifest, f.priorManifest), /regular file/);
});

test('failed pre-release backup restarts unchanged prior because candidate never ran or wrote data', (t) => {
  const f = fixture(t, { backupFails: true }), result = f.run();
  assert.equal(result.status, 1); assert.match(result.stderr, /Pre-release backup failed/);
  assert.equal(realpathSync(f.link), f.priorDir); assert.equal(readFileSync(f.database, 'utf8'), 'prior-data-retained');
  assert.equal(f.commands().at(-1), `start game-room.service ${f.priorDir}`);
});

test('initial unhealthy activation retains its candidate stopped; healthy activation succeeds even with incompatible prior', (t) => {
  const first = fixture(t, { initial: true }), failed = first.run();
  assert.equal(failed.status, 1); assert.match(failed.stderr, /Initial activation failed/);
  assert.equal(realpathSync(first.link), first.candidateDir); assert.ok(first.commands().at(-1).startsWith('stop game-room.service '));
  const next = fixture(t, { healthFails: false }), success = next.run();
  assert.equal(success.status, 0, success.stderr); assert.match(success.stdout, /Activated release/);
  assert.equal(realpathSync(next.link), next.candidateDir);
});

test('new artifact actually includes its compatibility guard and manifest declaration', (t) => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'game-compatibility-pack-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const release = buildRelease({ projectRoot: root, outputRoot });
  const value = JSON.parse(execFileSync('tar', ['-xOzf', release.artifact, 'release-manifest.json'], { encoding: 'utf8' }));
  assert.deepEqual(value.dataCompatibility, current());
  assert.equal(value.identityPolicy,'agora-account-security-v1');
  assert.ok(value.sourceFiles.some((entry) => entry.file === 'scripts/release-compatibility.mjs'));
  assert.equal(compareReleaseCompatibility(value, manifest(priorId)).rollbackCompatible, false);
  assert.ok(existsSync(release.artifact));
});
