import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { backupStore, verifyBackup } from '../server/backup.mjs';
import { runScheduledBackup, isolatedAwsEnvironment } from '../scripts/scheduled-backup.mjs';

const DAY = 86400000;
const current = Date.parse('2026-10-04T12:00:00.000Z');
const noAws = async () => { assert.fail('This test must reject before calling AWS'); };
function filename(time, salt = '0000000000000000') { return `backup-${new Date(time).toISOString().replaceAll(':', '-').replace('.', '-')}-${salt}.sqlite`; }
async function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'game-scheduled-backup-')));
  const backups = join(directory, 'backups'); mkdirSync(backups, { mode: 0o700 });
  const path = join(directory, 'live.sqlite'), key = randomBytes(32);
  const storage = new EncryptedStore(new SQLiteAdapter(path), key);
  const userKey = identityKey('synthetic-issuer', 'synthetic-member');
  await storage.put('game-profiles', userKey, { userKey, nickname: '测试用户' });
  t.after(() => { storage.close(); rmSync(directory, { recursive: true, force: true }); });
  const env = { GAME_ROOM_STORE_PATH: path, GAME_ROOM_BACKUP_DIR: backups, GAME_ROOM_BACKUP_BUCKET: 'dedicated-game-room-test' };
  async function oldBackup(time, salt) {
    const name = filename(time, salt);
    await backupStore({ sourcePath: path, destinationPath: join(backups, name), key, now: () => time });
    return name;
  }
  return { directory, backups, path, key, storage, env, oldBackup };
}
function fakeAws({ failUpload = false, badHead = false } = {}) {
  const objects = new Map(), calls = [], removed = [];
  const arg = (args, name) => args[args.indexOf(name) + 1];
  async function run(args) {
    calls.push(args);
    assert.ok(Array.isArray(args)); assert.equal(args[0], 's3api');
    assert.equal(arg(args, '--bucket'), 'dedicated-game-room-test');
    const key = arg(args, '--key');
    if (args[1] === 'put-object') {
      if (failUpload) throw new Error('synthetic offline upload');
      assert.equal(arg(args, '--if-none-match'), '*'); assert.ok(arg(args, '--body').endsWith('.sqlite'));
      assert.equal(objects.has(key), false, 'Upload must never overwrite an existing object');
      const metadata = JSON.parse(arg(args, '--metadata'));
      assert.equal(arg(args, '--checksum-sha256'), Buffer.from(metadata.sha256, 'hex').toString('base64'));
      objects.set(key, { Metadata: metadata, ETag: '"synthetic-etag"' }); return { ETag: '"synthetic-etag"' };
    }
    if (args[1] === 'head-object') {
      if (!objects.has(key)) { const error = new Error('missing'); error.name = 'NotFound'; throw error; }
      return badHead ? { Metadata: { ...objects.get(key).Metadata, sha256: '0'.repeat(64) } } : structuredClone(objects.get(key));
    }
    if (args[1] === 'list-objects-v2') return { IsTruncated: false, Contents: [...objects.keys()].filter((name) => name.startsWith(arg(args, '--prefix'))).map((Key) => ({ Key })) };
    if (args[1] === 'delete-object') { assert.equal(arg(args, '--if-match'), objects.get(key).ETag); removed.push(key); objects.delete(key); return {}; }
    throw new Error('Unexpected synthetic command');
  }
  return { run, calls, objects, removed };
}

test('scheduler uploads verified hourly and first daily snapshots then records non-secret success', async (t) => {
  const f = await fixture(t), aws = fakeAws();
  const first = await runScheduledBackup({ env: f.env, key: f.key, now: () => current, runAws: aws.run });
  assert.equal(first.offsiteVerified, true); assert.equal(first.recordCount, 1);
  assert.equal(aws.objects.size, 2); assert.equal(first.localPrune.removed, 0);
  verifyBackup({ sourcePath: join(f.backups, first.filename), key: f.key });
  const daily = structuredClone(aws.objects.get('game-room/v1/daily/backup-2026-10-04.sqlite'));
  await runScheduledBackup({ env: f.env, key: f.key, now: () => current + 30 * 60000, runAws: aws.run });
  assert.equal(aws.objects.size, 3); assert.deepEqual(aws.objects.get('game-room/v1/daily/backup-2026-10-04.sqlite'), daily);
  assert.equal(aws.calls.some((call) => call[1] === 'delete-object'), false);
  const status = readFileSync(join(f.backups, 'status.json'), 'utf8');
  assert.equal(status.includes(f.key.toString('base64url')), false); assert.equal(status.includes('测试用户'), false);
  assert.equal(lstatSync(join(f.backups, 'status.json')).mode & 0o777, 0o600);
});

test('upload or remote checksum failure retains local snapshot and leaves previous success status unchanged', async (t) => {
  const f = await fixture(t), good = fakeAws();
  await runScheduledBackup({ env: f.env, key: f.key, now: () => current, runAws: good.run });
  const before = readFileSync(join(f.backups, 'status.json'), 'utf8');
  await assert.rejects(runScheduledBackup({ env: f.env, key: f.key, now: () => current + 1, runAws: fakeAws({ failUpload: true }).run }), /offline upload/);
  await assert.rejects(runScheduledBackup({ env: f.env, key: f.key, now: () => current + 2, runAws: fakeAws({ badHead: true }).run }), /verification failed/);
  assert.equal(readFileSync(join(f.backups, 'status.json'), 'utf8'), before);
  assert.equal(readdirSync(f.backups).filter((name) => name.endsWith('.sqlite')).length, 3);
});

test('AWS subprocess environment discards account credentials, profiles, custom endpoints and store keys', () => {
  const env = isolatedAwsEnvironment({ PATH: '/safe/bin', AWS_ACCESS_KEY_ID: 'must-not-use', AWS_SECRET_ACCESS_KEY: 'must-not-use', AWS_SESSION_TOKEN: 'must-not-use',
    AWS_PROFILE: 'central', AWS_CONFIG_FILE: '/central/config', AWS_WEB_IDENTITY_TOKEN_FILE: '/central/token',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://unsafe', AWS_ENDPOINT_URL: 'https://unsafe', GAME_ROOM_STORE_KEY: 'secret', GAME_ROOM_STORE_KEY_FILE: '/protected/key' });
  assert.equal(env.AWS_REGION, 'ap-northeast-1'); assert.equal(env.AWS_CONFIG_FILE, '/dev/null'); assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
  assert.equal(env.AWS_EC2_METADATA_SERVICE_ENDPOINT, 'http://169.254.169.254');
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_ENDPOINT_URL', 'GAME_ROOM_STORE_KEY', 'GAME_ROOM_STORE_KEY_FILE']) assert.equal(env[name], undefined);
});

test('invalid directory permissions and symbolic ancestors fail before creating outside paths', async (t) => {
  const f = await fixture(t);
  const unsafe = join(f.directory, 'unsafe'); mkdirSync(unsafe, { mode: 0o755 });
  chmodSync(unsafe, 0o755); // The caller's restrictive umask must not repair this intentionally invalid fixture.
  await assert.rejects(runScheduledBackup({ env: { ...f.env, GAME_ROOM_BACKUP_DIR: unsafe }, key: f.key, now: () => current, runAws: noAws }), /0700 directory/);
  assert.equal(readdirSync(unsafe).length, 0);
  const linked = join(f.directory, 'linked'); symlinkSync(f.backups, linked);
  await assert.rejects(runScheduledBackup({ env: { ...f.env, GAME_ROOM_BACKUP_DIR: join(linked, 'outside') }, key: f.key, now: () => current, runAws: noAws }), /symbolic links/);
  assert.equal(existsSync(join(f.backups, 'outside')), false);
  assert.equal(readdirSync(f.backups).length, 0);
});

test('authorized local pruning retains latest 48 plus recent daily points and never deletes unverified files', async (t) => {
  const f = await fixture(t), aws = fakeAws();
  for (let index = 1; index <= 60; index++) await f.oldBackup(current - index * 30 * 60000, index.toString(16).padStart(16, '0'));
  const recentDaily = await f.oldBackup(current - 20 * DAY, 'ffffffffffffffff');
  const expired = await f.oldBackup(current - 40 * DAY, 'eeeeeeeeeeeeeeee');
  const tampered = filename(current - 41 * DAY, 'dddddddddddddddd'); writeFileSync(join(f.backups, tampered), 'preserve-damaged-file', { mode: 0o600 });
  const foreign = join(f.backups, 'notes.sqlite'); writeFileSync(foreign, 'preserve-user-file', { mode: 0o600 });
  const result = await runScheduledBackup({ env: { ...f.env, GAME_ROOM_BACKUP_PRUNE: '1' }, key: f.key, now: () => current, runAws: aws.run });
  assert.ok(result.localPrune.removed > 10); assert.equal(result.localPrune.ignored, 1);
  assert.equal(existsSync(join(f.backups, recentDaily)), true); assert.equal(existsSync(join(f.backups, expired)), false);
  assert.equal(readFileSync(join(f.backups, tampered), 'utf8'), 'preserve-damaged-file'); assert.equal(readFileSync(foreign, 'utf8'), 'preserve-user-file');
  assert.equal(readdirSync(f.backups).filter((name) => /^backup-/.test(name) && name !== tampered).length, 49);
});

test('remote pruning requires exact prefixes, filenames and matching project metadata', async (t) => {
  const f = await fixture(t), aws = fakeAws();
  const guard = verifyBackup({ sourcePath: await f.oldBackup(current - DAY).then((name) => join(f.backups, name)), key: f.key }).manifest.keyId;
  for (let index = 1; index <= 60; index++) {
    const time = current - index * 30 * 60000, origin = filename(time, index.toString(16).padStart(16, '0'));
    aws.objects.set(`game-room/v1/hourly/${origin}`, { ETag: '"synthetic-etag"', Metadata: { project: 'game-room', format: '1', 'key-id': guard, sha256: 'a'.repeat(64), origin, 'created-at': String(time) } });
  }
  const oldTime = current - 40 * DAY, oldOrigin = filename(oldTime, 'eeeeeeeeeeeeeeee');
  aws.objects.set('game-room/v1/daily/backup-2026-08-25.sqlite', { ETag: '"synthetic-etag"', Metadata: { project: 'game-room', format: '1', 'key-id': guard, sha256: 'a'.repeat(64), origin: oldOrigin, 'created-at': String(oldTime) } });
  const foreignKey = `game-room/v1/hourly/${filename(current - 100 * DAY, 'ffffffffffffffff')}`;
  aws.objects.set(foreignKey, { Metadata: { project: 'calendar' } });
  aws.objects.set('calendar/private.sqlite', { Metadata: { project: 'calendar' } });
  aws.objects.set('game-room/v1/hourly/notes.sqlite', { Metadata: { project: 'game-room' } });
  await runScheduledBackup({ env: { ...f.env, GAME_ROOM_BACKUP_PRUNE: '1' }, key: f.key, now: () => current, runAws: aws.run });
  assert.ok(aws.removed.length >= 13); assert.equal(aws.objects.has(foreignKey), true);
  assert.equal(aws.objects.has('calendar/private.sqlite'), true); assert.equal(aws.objects.has('game-room/v1/hourly/notes.sqlite'), true);
  assert.ok(aws.removed.every((name) => name.startsWith('game-room/v1/hourly/') || name.startsWith('game-room/v1/daily/')));
});

test('local-only mode does not call AWS or prune unless separately enabled', async (t) => {
  const f = await fixture(t);
  const old = await f.oldBackup(current - 100 * DAY);
  const result = await runScheduledBackup({ env: { ...f.env, GAME_ROOM_BACKUP_BUCKET: '' }, key: f.key, now: () => current,
    runAws: async () => { throw new Error('AWS must not be called'); } });
  assert.equal(result.offsiteVerified, false); assert.equal(existsSync(join(f.backups, old)), true);
});

test('retention never removes the configured live source, even when it has an old valid backup filename', async (t) => {
  const f = await fixture(t);
  for (let index = 1; index <= 50; index++) await f.oldBackup(current - index * 30 * 60000, index.toString(16).padStart(16, '0'));
  const archived = await f.oldBackup(current - 100 * DAY, 'ffffffffffffffff');
  const source = join(f.backups, archived);
  await runScheduledBackup({ env: { ...f.env, GAME_ROOM_STORE_PATH: source, GAME_ROOM_BACKUP_BUCKET: '', GAME_ROOM_BACKUP_PRUNE: '1' }, key: f.key, now: () => current, runAws: noAws });
  assert.equal(existsSync(source), true);
  verifyBackup({ sourcePath: source, key: f.key });
});

test('default executor uses a local fake CLI with Tokyo region, argument arrays and no inherited credentials', async (t) => {
  const f = await fixture(t), executable = join(f.directory, 'fake-aws'), state = join(f.directory, 'fake-state.json');
  writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), file = process.env.GAME_ROOM_FAKE_STATE;
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {objects:{},calls:[]};
const field = (name) => args[args.indexOf(name)+1];
saved.calls.push({args,env:Object.fromEntries(Object.entries(process.env).filter(([name])=>name.startsWith('AWS_')||name.startsWith('GAME_ROOM_STORE_KEY')))});
let result = {};
if(args[1]==='put-object') saved.objects[field('--key')]={Metadata:JSON.parse(field('--metadata'))};
if(args[1]==='head-object') {
  result=saved.objects[field('--key')];
  if(!result){fs.writeFileSync(file,JSON.stringify(saved));process.stderr.write('An error occurred (404)');process.exit(1);}
}
fs.writeFileSync(file,JSON.stringify(saved));process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
  const keyFile = join(f.directory, 'key'); writeFileSync(keyFile, f.key.toString('base64url'), { mode: 0o600 });
  await runScheduledBackup({ env: { ...process.env, ...f.env, GAME_ROOM_AWS_CLI: executable, GAME_ROOM_FAKE_STATE: state,
    GAME_ROOM_STORE_KEY: '', GAME_ROOM_STORE_KEY_FILE: keyFile, AWS_PROFILE: 'central-do-not-use', AWS_ACCESS_KEY_ID: 'synthetic-do-not-use' }, now: () => current });
  const calls = JSON.parse(readFileSync(state, 'utf8')).calls;
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('--region') + 1], 'ap-northeast-1');
    assert.ok(call.args.includes('--no-cli-pager')); assert.equal(call.env.AWS_CONFIG_FILE, '/dev/null');
    assert.equal(call.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null'); assert.equal(call.env.AWS_PROFILE, undefined);
    assert.equal(call.env.AWS_ACCESS_KEY_ID, undefined); assert.equal(call.env.GAME_ROOM_STORE_KEY_FILE, undefined);
    assert.equal(call.args.includes('--profile'), false);
  }
});
