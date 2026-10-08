import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CURRENT_DATA_COMPATIBILITY } from '../scripts/release-compatibility.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidateId = 'd'.repeat(20), priorId = 'e'.repeat(20);
const originalData = 'synthetic-prior-business-data';
const newData = 'synthetic-data-with-wordbank-and-canvas-scopes';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const compatibility = () => structuredClone(CURRENT_DATA_COMPATIBILITY);
function priorCompatibility() {
  const value = compatibility();
  value.roomSnapshots = { read: value.roomSnapshots.read.filter(n => n <= 9), write: value.roomSnapshots.write.filter(n => n <= 9) };
  value.backupScopes = { read: value.backupScopes.read.slice(0, 9), write: value.backupScopes.write.slice(0, 9) };
  return value;
}
function manifest(releaseId, dataCompatibility) {
  return { format: 1, project: 'game-room', releaseId, containsSecrets: false,
    containsUserData: false, identityPolicy: 'agora-account-security-v1', dataCompatibility };
}

// Serialized into a fixture-owned executable. These substitutes model external
// commands only; the actual Bash branch ordering and filesystem link changes run.
function fakeCommand(command, args, options) {
  const load = () => JSON.parse(fs.readFileSync(options.state, 'utf8'));
  const save = value => fs.writeFileSync(options.state, JSON.stringify(value));
  const current = () => { try { return fs.realpathSync(options.link); } catch { return null; } };
  const event = (type, fields = {}) => fs.appendFileSync(options.log, JSON.stringify({ type, current: current(), ...fields }) + '\n');
  const owned = file => assert.ok(file.startsWith(options.directory + '/'), 'Fake commands must stay in their owned fixture');
  function beginBackup(state) {
    state.backupJobQueued = false; state.backupInvocation = 'b'.repeat(32); state.backupActive = 'activating';
    state.backupResult = 'success'; state.backupPhase = 'new'; state.backupPollsRemaining = options.newBackupPolls;
    save(state); event('new-backup-started', { invocation: state.backupInvocation, stopped: !state.running });
  }
  function unitSettings(files, unit) {
    const credentials = {}, environment = {};
    for (const file of files) {
      let service = false;
      for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[')) { service = line === '[Service]'; continue; }
        if (!service || !line || line.startsWith('#')) continue;
        if (line.startsWith('LoadCredential=')) {
          const value = line.slice('LoadCredential='.length);
          if (!value) { for (const id of Object.keys(credentials)) delete credentials[id]; }
          else { const colon = value.indexOf(':'); credentials[value.slice(0, colon)] = value.slice(colon + 1); }
        }
        if (line.startsWith('Environment=')) {
          const value = line.slice('Environment='.length), equals = value.indexOf('=');
          environment[value.slice(0, equals)] = value.slice(equals + 1).replaceAll('%d', `/run/credentials/${unit}`);
        }
      }
    }
    return { credentials, environment };
  }
  function preflight(stage, unit, credentials, environment) {
    const state = load();
    assert.equal(state.running, false, 'Candidate preflight requires the old process to be stopped');
    assert.equal(current(), options.candidateDir);
    if (!options.initial) assert.equal(state.backupFinished, true, 'No initializer may precede the final old backup');
    for (const source of Object.values(credentials)) { owned(source); assert.equal(fs.lstatSync(source).isFile(), true); }
    event('preflight', { stage, unit, credentials, environment });
    assert.equal(credentials['store-key'], options.storeKey);
    assert.equal(environment.GAME_ROOM_STORE_KEY_FILE, `/run/credentials/${unit}/store-key`);
    if (options.batchEnabled && (credentials['identity-batch-key'] !== options.identityKey
        || environment.GAME_ROOM_IDENTITY_BATCH_KEY_FILE !== `/run/credentials/${unit}/identity-batch-key`)) {
      event('preflight-rejected', { stage, reason: 'missing-identity-credential' }); return 1;
    }
    if (options.drawingEnabled) { fs.writeFileSync(options.database, options.newData); event('initialize', { stage }); }
    if (stage === 'transient' && options.preflightFails) return 1;
    return 0;
  }
  if (command === 'id') { assert.deepEqual(args, ['-u']); process.stdout.write('0\n'); return 0; }
  if (command === 'stat') {
    assert.equal(args[0], '-c'); owned(args[2]);
    const info = fs.lstatSync(args[2]);
    if (args[1] === '%u') process.stdout.write('0\n');
    else {
      assert.equal(args[1], '%u:%a'); assert.equal(args[2], options.identityKey);
      process.stdout.write(`${options.keyWrongOwner ? 501 : 0}:${(info.mode & 0o777).toString(8)}\n`);
    }
    return 0;
  }
  if (command === 'readlink') { assert.equal(args[0], '-f'); owned(args[1]); process.stdout.write(fs.realpathSync(args[1]) + '\n'); return 0; }
  if (command === 'mv') {
    assert.equal(args[0], '-Tf'); owned(args[1]); owned(args[2]);
    fs.renameSync(args[1], args[2]); event('switch'); return 0;
  }
  if (command === 'systemd-run') {
    const unit = args.find(arg => arg.startsWith('--unit=')).slice('--unit='.length) + '.service';
    const credentials = {}, environment = {};
    for (const arg of args) {
      if (arg.startsWith('--property=LoadCredential=')) {
        const value = arg.slice('--property=LoadCredential='.length), colon = value.indexOf(':');
        assert.equal(Object.hasOwn(credentials, value.slice(0, colon)), false);
        credentials[value.slice(0, colon)] = value.slice(colon + 1);
      }
      if (arg.startsWith('--setenv=')) {
        const value = arg.slice('--setenv='.length), equals = value.indexOf('=');
        environment[value.slice(0, equals)] = value.slice(equals + 1);
      }
    }
    assert.equal(unit, `game-room-preflight-${options.candidateId}.service`);
    assert.ok(args.includes('--property=User=game-room'));
    assert.ok(args.includes('--property=Group=game-room'));
    assert.ok(args.includes(`--property=WorkingDirectory=${options.candidateDir}`));
    assert.ok(args.includes(`--property=EnvironmentFile=${options.runtimeEnv}`));
    assert.equal(args.at(-1), 'scripts/production-preflight.mjs');
    return preflight('transient', unit, credentials, environment);
  }
  if (command === 'systemctl') {
    const state = load();
    if (args[0] === 'show') {
      assert.deepEqual(args, ['show', '--property=ActiveState', '--property=InvocationID', '--property=Result', 'game-room-backup.service']);
      assert.equal(state.running, false); assert.equal(current(), options.priorDir);
      if (options.backupStateReadFails) { event('backup-state-error'); return 1; }
      if (state.backupJobQueued && state.backupJobPolls-- <= 0) beginBackup(state);
      if (['active', 'activating', 'reloading', 'deactivating'].includes(state.backupActive)) {
        const stuck = state.backupPhase === 'old' ? options.oldBackupNeverFinishes : options.newBackupNeverFinishes;
        if (!stuck && state.backupPollsRemaining-- <= 0) {
          state.backupActive = state.backupPhase === 'new' && options.newBackupFails ? 'failed' : 'inactive';
          state.backupResult = state.backupActive === 'failed' ? 'exit-code' : 'success';
          if (state.backupPhase === 'old') {
            fs.writeFileSync(options.backup, 'synthetic-earlier-business-data'); event('old-backup-finished', { invocation: state.backupInvocation });
          } else if (state.backupActive === 'inactive') {
            assert.equal(fs.readFileSync(options.database, 'utf8'), options.originalData);
            fs.copyFileSync(options.database, options.backup); state.backupFinished = true;
            event('backup-finished', { invocation: state.backupInvocation });
          } else event('backup-failed', { invocation: state.backupInvocation });
        }
      }
      save(state);
      event('backup-state', { activeState: state.backupActive, invocation: state.backupInvocation, result: state.backupResult });
      // Keyed properties intentionally arrive in a different order than requested.
      process.stdout.write(`Result=${state.backupResult}\nInvocationID=${state.backupInvocation}\nActiveState=${state.backupActive}\n`);
      return 0;
    }
    const operation = args[0], unit = args.at(-1);
    assert.deepEqual(args, unit === 'game-room-backup.service' ? ['start', '--no-block', unit] : [operation, unit]);
    assert.ok(['start', 'stop'].includes(operation));
    assert.ok(['game-room.service', 'game-room-backup.service'].includes(unit));
    event(operation, { unit });
    if (operation === 'stop') { assert.equal(unit, 'game-room.service'); state.running = false; save(state); return 0; }
    if (unit === 'game-room-backup.service') {
      assert.equal(state.running, false); assert.equal(current(), options.priorDir);
      assert.equal(fs.readFileSync(options.database, 'utf8'), options.originalData);
      if (options.backupFails) return 1;
      // Model systemd start's real coalescing behavior for a still-running unit.
      if (['active', 'activating', 'reloading', 'deactivating'].includes(state.backupActive)) return 0;
      if (options.backupStartSameInvocation) return 0;
      if (options.backupStartDelay) {
        state.backupJobQueued = true; state.backupJobPolls = options.backupStartDelay;
        save(state); event('new-backup-queued');
      } else beginBackup(state);
      return 0;
    }
    if (current() === options.candidateDir) {
      const files = [options.service]; if (options.dropInInstalled) files.push(options.dropIn);
      const settings = unitSettings(files, unit);
      const result = preflight('main', unit, settings.credentials, settings.environment);
      if (result || options.startFails) return 1;
    } else assert.equal(current(), options.priorDir);
    state.running = true; save(state); return 0;
  }
  if (command === 'curl') {
    assert.equal(load().running, true); assert.equal(current(), options.candidateDir);
    assert.equal(args.at(-1), 'http://127.0.0.1:4177/healthz'); event('health'); return options.healthFails ? 1 : 0;
  }
  if (command === 'sleep') { assert.deepEqual(args, ['1']); event('wait', { seconds: options.waitStep }); return 0; }
  throw new Error(`Unexpected fake command ${command}`);
}

function fixture(t, overrides = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'game-activation-order-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gameRoot = join(directory, 'game-room'), config = join(directory, 'config');
  const candidateDir = join(gameRoot, 'releases', candidateId), priorDir = join(gameRoot, 'releases', priorId);
  const options = { directory, gameRoot, config, candidateId, candidateDir, priorDir, originalData, newData,
    state: join(directory, 'state.json'), log: join(directory, 'events.jsonl'), link: join(gameRoot, 'current'),
    database: join(directory, 'business-marker'), backup: join(directory, 'final-old-backup'),
    runtimeEnv: join(config, 'runtime.env'), storeKey: join(config, 'store-key'), identityKey: join(config, 'identity-batch-key'),
    service: join(directory, 'game-room.service'), dropIn: join(directory, 'game-room-identity-batch.conf'),
    drawingEnabled: true, batchEnabled: false, dropInInstalled: false,
    oldBackupState: 'inactive', oldBackupPolls: 1, newBackupPolls: 1, waitStep: 1, ...overrides };
  fs.mkdirSync(join(candidateDir, 'scripts'), { recursive: true }); fs.mkdirSync(priorDir, { recursive: true }); fs.mkdirSync(config);
  fs.copyFileSync(join(root, 'scripts/release-compatibility.mjs'), join(candidateDir, 'scripts/release-compatibility.mjs'));
  fs.writeFileSync(join(candidateDir, 'release-manifest.json'), JSON.stringify(manifest(candidateId, options.candidate ?? compatibility())));
  fs.writeFileSync(join(priorDir, 'release-manifest.json'), JSON.stringify(manifest(priorId, options.prior ?? priorCompatibility())));
  fs.writeFileSync(options.runtimeEnv, `GAME_ROOM_DRAWING_ENABLED=${Number(options.drawingEnabled)}\nGAME_ROOM_IDENTITY_BATCH_ENABLED=${Number(options.batchEnabled)}\n`);
  fs.writeFileSync(options.storeKey, 'synthetic-store-key-placeholder', { mode: 0o600 });
  if (options.keyState === 'regular' || options.keyState === 'permissive' || options.keyWrongOwner) {
    fs.writeFileSync(options.identityKey, 'synthetic-signing-key-placeholder', { mode: 0o600 });
    fs.chmodSync(options.identityKey, options.keyState === 'permissive' ? 0o644 : (options.keyMode ?? 0o600));
  } else if (options.keyState === 'symlink') fs.symlinkSync(options.storeKey, options.identityKey);
  else if (options.keyState === 'dangling') fs.symlinkSync(join(config, 'absent'), options.identityKey);
  else if (options.keyState === 'directory') fs.mkdirSync(options.identityKey);
  fs.writeFileSync(options.database, originalData); fs.writeFileSync(options.log, '');
  fs.writeFileSync(options.state, JSON.stringify({ running: !options.initial, backupFinished: false,
    backupActive: options.oldBackupState, backupInvocation: 'a'.repeat(32), backupPhase: 'old',
    backupResult: options.oldBackupState === 'failed' ? 'exit-code' : 'success', backupPollsRemaining: options.oldBackupPolls }));
  if (!options.initial) fs.symlinkSync(priorDir, options.link);
  const original = fs.readFileSync(join(root, 'infra/activate-release.sh'), 'utf8');
  const relocations = [['/opt/game-room', gameRoot], ['/etc/game-room', config], ['/opt/node/bin/node', process.execPath]];
  const relocate = text => relocations.reduce((value, [from, to]) => value.replaceAll(from, to), text);
  const script = relocate(original);
  // Invert the precise relocations: no control-flow, root gate or flags change.
  assert.equal(relocations.reduceRight((value, [from, to]) => value.replaceAll(to, from), script), original);
  const scriptPath = join(directory, 'activate-release.sh'), shellEnvironment = join(directory, 'shell-environment.sh');
  fs.writeFileSync(scriptPath, script);
  fs.writeFileSync(options.service, relocate(fs.readFileSync(join(root, 'infra/game-room.service'), 'utf8')));
  fs.writeFileSync(options.dropIn, relocate(fs.readFileSync(join(root, 'infra/game-room-identity-batch.conf'), 'utf8')));
  const helper = join(directory, 'fake-command.mjs');
  fs.writeFileSync(helper, `import assert from 'node:assert/strict';\nimport * as fs from 'node:fs';\nconst options=${JSON.stringify(options)};\nprocess.exitCode=(${fakeCommand.toString()})(process.argv[2],process.argv.slice(3),options);\n`);
  fs.writeFileSync(shellEnvironment, ['id', 'stat', 'readlink', 'mv', 'systemd-run', 'systemctl', 'curl']
    .map(command => `${command}() { ${quote(process.execPath)} ${quote(helper)} ${quote(command)} "$@"; }`).join('\n')
    + `\nsleep() { ${quote(process.execPath)} ${quote(helper)} sleep "$@" && SECONDS=$((SECONDS + ${options.waitStep})); }\n`);
  return { ...options,
    run: () => spawnSync('/bin/bash', [scriptPath, candidateId], { encoding: 'utf8',
      env: { BASH_ENV: shellEnvironment, PATH: '/usr/bin:/bin' }, timeout: 15000 }),
    events: () => fs.readFileSync(options.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    effects: () => fs.readFileSync(options.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(event => !['backup-state', 'wait', 'new-backup-started', 'new-backup-queued'].includes(event.type)),
    stateValue: () => JSON.parse(fs.readFileSync(options.state, 'utf8')) };
}

test('actual shell backs up stopped prior code before candidate initialization and healthy start', t => {
  const f = fixture(t), result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.effects().map(e => e.type), ['stop', 'start', 'backup-finished', 'switch', 'preflight', 'initialize', 'start', 'preflight', 'initialize', 'health']);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), originalData); assert.equal(fs.readFileSync(f.database, 'utf8'), newData);
  assert.equal(fs.realpathSync(f.link), f.candidateDir); assert.equal(f.stateValue().running, true);
});

test('failed final backup restarts only unchanged prior and never switches or initializes candidate', t => {
  const f = fixture(t, { backupFails: true }), result = f.run(); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Pre-release backup failed/);
  assert.deepEqual(f.effects().map(e => [e.type, e.current]), [['stop', f.priorDir], ['start', f.priorDir], ['start', f.priorDir]]);
  assert.equal(fs.realpathSync(f.link), f.priorDir); assert.equal(fs.readFileSync(f.database, 'utf8'), originalData);
  assert.equal(fs.existsSync(f.backup), false); assert.equal(f.stateValue().running, true);
});

for (const oldBackupState of ['active', 'activating']) {
  test(`an old ${oldBackupState} timer backup must finish before a distinct stopped-service invocation`, t => {
    const f = fixture(t, { oldBackupState }), result = f.run(); assert.equal(result.status, 0, result.stderr);
    const events = f.events(), oldFinished = events.findIndex(event => event.type === 'old-backup-finished');
    const freshStart = events.findIndex(event => event.type === 'new-backup-started');
    const freshFinished = events.findIndex(event => event.type === 'backup-finished');
    const switchIndex = events.findIndex(event => event.type === 'switch');
    assert.equal(events[0].type, 'stop');
    assert.ok(oldFinished > 0 && freshStart > oldFinished && freshFinished > freshStart && switchIndex > freshFinished);
    assert.equal(events[oldFinished].invocation, 'a'.repeat(32));
    assert.equal(events[freshStart].invocation, 'b'.repeat(32)); assert.equal(events[freshStart].stopped, true);
    assert.equal(events[freshFinished].invocation, events[freshStart].invocation);
    assert.ok(events.filter(event => event.type === 'backup-state').some(event => event.activeState === oldBackupState));
    assert.equal(events.some(event => event.type === 'stop' && event.unit === 'game-room-backup.service'), false);
    assert.equal(fs.readFileSync(f.backup, 'utf8'), originalData, 'the earlier timer snapshot must be replaced by the new final snapshot');
    assert.equal(fs.realpathSync(f.link), f.candidateDir); assert.equal(f.stateValue().running, true);
  });
}

test('an ended failed timer invocation does not prevent a new successful final backup', t => {
  const f = fixture(t, { oldBackupState: 'failed' }), result = f.run(); assert.equal(result.status, 0, result.stderr);
  const states = f.events().filter(event => event.type === 'backup-state');
  assert.deepEqual([states[0].activeState, states[0].result, states[0].invocation], ['failed', 'exit-code', 'a'.repeat(32)]);
  assert.deepEqual([states.at(-1).activeState, states.at(-1).result, states.at(-1).invocation], ['inactive', 'success', 'b'.repeat(32)]);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), originalData); assert.equal(fs.realpathSync(f.link), f.candidateDir);
});

test('an old backup exceeding its drain budget stays running while unchanged prior code safely resumes', t => {
  const f = fixture(t, { oldBackupState: 'activating', oldBackupNeverFinishes: true, waitStep: 60 }), result = f.run();
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /Pre-release backup failed/);
  assert.equal(f.events().filter(event => event.type === 'backup-state').length, 2);
  assert.deepEqual(f.events().filter(event => event.type === 'wait').map(event => event.seconds), [60]);
  assert.equal(f.events().some(event => event.type === 'start' && event.unit === 'game-room-backup.service'), false);
  assert.equal(f.events().some(event => event.type === 'switch' || event.type === 'preflight'), false);
  assert.equal(f.stateValue().backupActive, 'activating'); assert.equal(f.stateValue().backupInvocation, 'a'.repeat(32));
  assert.equal(fs.realpathSync(f.link), f.priorDir); assert.equal(fs.readFileSync(f.database, 'utf8'), originalData);
  assert.equal(f.stateValue().running, true); assert.equal(fs.existsSync(f.backup), false);
});

test('a new backup exceeding its completion budget is not killed and cannot allow initialization', t => {
  const f = fixture(t, { newBackupNeverFinishes: true, waitStep: 300 }), result = f.run();
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /Pre-release backup failed/);
  assert.deepEqual(f.events().filter(event => event.type === 'wait').map(event => event.seconds), [300]);
  assert.equal(f.events().filter(event => event.type === 'new-backup-started').length, 1);
  assert.equal(f.events().some(event => event.type === 'backup-finished' || event.type === 'switch' || event.type === 'preflight'), false);
  assert.equal(f.stateValue().backupActive, 'activating'); assert.equal(f.stateValue().backupInvocation, 'b'.repeat(32));
  assert.equal(fs.realpathSync(f.link), f.priorDir); assert.equal(fs.readFileSync(f.database, 'utf8'), originalData);
  assert.equal(f.stateValue().running, true);
});

test('a failed newly started invocation is distinct but still refuses activation before any candidate write', t => {
  const f = fixture(t, { newBackupFails: true }), result = f.run(); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Pre-release backup failed/);
  assert.equal(f.stateValue().backupInvocation, 'b'.repeat(32)); assert.equal(f.stateValue().backupActive, 'failed');
  assert.equal(f.events().some(event => event.type === 'backup-finished' || event.type === 'switch' || event.type === 'preflight'), false);
  assert.equal(fs.realpathSync(f.link), f.priorDir); assert.equal(fs.readFileSync(f.database, 'utf8'), originalData);
  assert.equal(f.stateValue().running, true);
});

test('a successful start command cannot pass when it only reports the prior completed invocation', t => {
  const f = fixture(t, { backupStartSameInvocation: true, waitStep: 300 }), result = f.run(); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Pre-release backup failed/); assert.equal(f.stateValue().backupInvocation, 'a'.repeat(32));
  assert.equal(f.events().some(event => event.type === 'new-backup-started' || event.type === 'switch' || event.type === 'preflight'), false);
  assert.equal(fs.realpathSync(f.link), f.priorDir); assert.equal(f.stateValue().running, true);
});

test('a delayed accepted start waits through the old ended invocation until the new backup actually completes', t => {
  for (const oldBackupState of ['inactive', 'failed']) {
    const f = fixture(t, { oldBackupState, backupStartDelay: 1 }), result = f.run(); assert.equal(result.status, 0, result.stderr);
    const events = f.events(), queued = events.findIndex(event => event.type === 'new-backup-queued');
    const started = events.findIndex(event => event.type === 'new-backup-started');
    const finished = events.findIndex(event => event.type === 'backup-finished');
    assert.ok(queued > 0 && started > queued && finished > started);
    assert.ok(events.slice(queued + 1, started).some(event => event.type === 'backup-state'
      && event.activeState === oldBackupState && event.invocation === 'a'.repeat(32)));
    assert.ok(events.slice(queued + 1, started).some(event => event.type === 'wait'));
    assert.ok(events.findIndex(event => event.type === 'switch') > finished);
    assert.equal(events[started].invocation, 'b'.repeat(32)); assert.equal(events[started].stopped, true);
    assert.equal(fs.readFileSync(f.backup, 'utf8'), originalData); assert.equal(fs.realpathSync(f.link), f.candidateDir);
  }
});

test('unreadable or unknown backup state refuses before start and restores unchanged prior code', t => {
  for (const failure of [{ backupStateReadFails: true }, { oldBackupState: 'maintenance' }]) {
    const f = fixture(t, failure), result = f.run(); assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Pre-release backup failed/);
    assert.equal(f.events().some(event => event.type === 'start' && event.unit === 'game-room-backup.service'), false);
    assert.equal(f.events().some(event => event.type === 'switch' || event.type === 'preflight'), false);
    assert.equal(fs.realpathSync(f.link), f.priorDir); assert.equal(fs.readFileSync(f.database, 'utf8'), originalData);
    assert.equal(f.stateValue().running, true);
  }
});

test('candidate preflight failure after initializing new scopes retains candidate stopped when rollback is forbidden', t => {
  const f = fixture(t, { preflightFails: true }), result = f.run(); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AUTOMATIC ROLLBACK FORBIDDEN/);
  assert.deepEqual(f.effects().map(e => e.type), ['stop', 'start', 'backup-finished', 'switch', 'preflight', 'initialize', 'stop']);
  assert.equal(fs.realpathSync(f.link), f.candidateDir); assert.equal(f.stateValue().running, false);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), originalData); assert.equal(fs.readFileSync(f.database, 'utf8'), newData);
  assert.equal(f.events().filter(e => e.type === 'start' && e.unit === 'game-room.service').length, 0);
});

test('compatible preflight failure restores prior code while retaining the initialized business data', t => {
  const f = fixture(t, { preflightFails: true, prior: compatibility() }), result = f.run(); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /prior code restored/); assert.equal(fs.realpathSync(f.link), f.priorDir);
  assert.equal(fs.readFileSync(f.database, 'utf8'), newData); assert.equal(f.stateValue().running, true);
  assert.deepEqual(f.events().slice(-3).map(e => [e.type, e.current]), [['stop', f.candidateDir], ['switch', f.priorDir], ['start', f.priorDir]]);
});

test('candidate start and health failures both use the same incompatible rollback guard', t => {
  for (const failure of [{ startFails: true }, { healthFails: true }]) {
    const f = fixture(t, failure), result = f.run(); assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /AUTOMATIC ROLLBACK FORBIDDEN/);
    assert.equal(fs.realpathSync(f.link), f.candidateDir); assert.equal(f.stateValue().running, false);
    assert.equal(fs.readFileSync(f.database, 'utf8'), newData);
    assert.ok(!f.events().some(e => e.type === 'start' && e.unit === 'game-room.service' && e.current === f.priorDir));
  }
});

test('root-private signing source is loaded separately into main and transient credentials without replacing the store key', t => {
  for (const keyMode of [0o400, 0o600]) {
    const f = fixture(t, { keyState: 'regular', keyMode, batchEnabled: true, dropInInstalled: true }), result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const checks = f.events().filter(e => e.type === 'preflight'); assert.equal(checks.length, 2);
    for (const check of checks) {
      assert.deepEqual(check.credentials, { 'store-key': f.storeKey, 'identity-batch-key': f.identityKey });
      assert.equal(check.environment.GAME_ROOM_IDENTITY_BATCH_KEY_FILE, `/run/credentials/${check.unit}/identity-batch-key`);
    }
    assert.notEqual(checks[0].environment.GAME_ROOM_IDENTITY_BATCH_KEY_FILE, checks[1].environment.GAME_ROOM_IDENTITY_BATCH_KEY_FILE);
  }
});

test('installing a signing credential leaves disabled feature flags and business data unchanged', t => {
  const f = fixture(t, { keyState: 'regular', dropInInstalled: true, drawingEnabled: false }), before = fs.readFileSync(f.runtimeEnv);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(f.runtimeEnv), before); assert.equal(fs.readFileSync(f.database, 'utf8'), originalData);
  assert.equal(f.events().some(e => e.type === 'initialize'), false);
  assert.ok(f.events().filter(e => e.type === 'preflight').every(e => e.credentials['identity-batch-key'] === f.identityKey));
});

test('absent signing source is not created or loaded and an enabled batch preflight rejects it safely', t => {
  const f = fixture(t, { batchEnabled: true }), result = f.run(); assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(f.identityKey), false); assert.equal(fs.readFileSync(f.database, 'utf8'), originalData);
  const check = f.events().find(e => e.type === 'preflight'); assert.deepEqual(check.credentials, { 'store-key': f.storeKey });
  assert.equal(Object.hasOwn(check.environment, 'GAME_ROOM_IDENTITY_BATCH_KEY_FILE'), false);
  assert.ok(f.events().some(e => e.type === 'preflight-rejected'));
  assert.equal(fs.realpathSync(f.link), f.candidateDir); assert.equal(f.stateValue().running, false);
});

test('main-service drop-in is an independent installation requirement, not implied by successful transient credential loading', t => {
  const f = fixture(t, { keyState: 'regular', batchEnabled: true }), result = f.run(); assert.equal(result.status, 1, result.stderr);
  const checks = f.events().filter(e => e.type === 'preflight');
  assert.equal(checks[0].credentials['identity-batch-key'], f.identityKey);
  assert.equal(Object.hasOwn(checks[1].credentials, 'identity-batch-key'), false);
  assert.ok(f.events().some(e => e.type === 'preflight-rejected' && e.stage === 'main'));
  assert.equal(f.stateValue().running, false); assert.equal(fs.realpathSync(f.link), f.candidateDir);
});

test('symlink, dangling link, directory, permissive or non-root signing source fails before stopping the original service', t => {
  for (const key of [{ keyState: 'symlink' }, { keyState: 'dangling' }, { keyState: 'directory' }, { keyState: 'permissive' }, { keyWrongOwner: true }]) {
    const f = fixture(t, key), result = f.run(); assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /signing[- ]key/); assert.deepEqual(f.events(), []);
    assert.equal(fs.realpathSync(f.link), f.priorDir); assert.equal(f.stateValue().running, true);
    assert.equal(fs.readFileSync(f.database, 'utf8'), originalData);
  }
});

test('forward-incompatible manifest rejects before any external command or database change', t => {
  const f = fixture(t, { candidate: priorCompatibility(), prior: compatibility() }), result = f.run();
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /CANDIDATE_DATA_INCOMPATIBLE/);
  assert.deepEqual(f.events(), []); assert.equal(fs.realpathSync(f.link), f.priorDir);
  assert.equal(fs.readFileSync(f.database, 'utf8'), originalData); assert.equal(f.stateValue().running, true);
});

test('initial preflight failure retains the candidate stopped without inventing an old backup or rollback target', t => {
  const f = fixture(t, { initial: true, preflightFails: true }), result = f.run(); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Initial activation failed/); assert.equal(fs.realpathSync(f.link), f.candidateDir);
  assert.equal(fs.existsSync(f.backup), false); assert.equal(f.stateValue().running, false);
  assert.deepEqual(f.events().map(e => e.type), ['stop', 'switch', 'preflight', 'initialize', 'stop']);
});
