import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, realpathSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupStore, verifyBackup } from '../server/backup.mjs';
import { readStoreKey } from '../server/config.mjs';

const execute = promisify(execFile);
const REGION = 'ap-northeast-1';
const PREFIX = 'game-room/v1/';
const filenamePattern = /^backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9]{16}\.sqlite$/;
const dayMs = 86400000;
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function timestamp(name) {
  const match = filenamePattern.exec(name);
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? { time, day: match[1] } : null;
}
function regularOwned(path) {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077) && (!process.getuid || info.uid === process.getuid());
}
function backupDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path === '/') throw new Error('Backup directory requires a dedicated absolute path');
  let parent = path;
  for (;;) {
    try { lstatSync(parent); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent); }
  }
  if (realpathSync(parent) !== resolve(parent)) throw new Error('Backup directory ancestors cannot contain symbolic links');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
    || (process.getuid && info.uid !== process.getuid()) || realpathSync(path) !== resolve(path)) throw new Error('Backup directory must be an owned 0700 directory without symbolic links');
  return path;
}
export function isolatedAwsEnvironment(env) {
  const isolated = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('AWS_') && !['GAME_ROOM_STORE_KEY', 'GAME_ROOM_STORE_KEY_FILE'].includes(name)));
  return { ...isolated, AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION, AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254',
    AWS_METADATA_SERVICE_TIMEOUT: '2', AWS_METADATA_SERVICE_NUM_ATTEMPTS: '2', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' };
}
function awsRunner(env) {
  const binary = env.GAME_ROOM_AWS_CLI || '/usr/local/bin/aws';
  if (!isAbsolute(binary)) throw new Error('AWS CLI requires an absolute executable path');
  return async (args) => {
    const { stdout } = await execute(binary, [...args, '--region', REGION, '--output', 'json', '--no-cli-pager',
      '--cli-connect-timeout', '10', '--cli-read-timeout', '30'], { env: isolatedAwsEnvironment(env), timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  };
}
const absent = (error) => /\((?:404|NoSuchKey|NotFound)\)/.test(error.stderr ?? '') || error.name === 'NotFound';
function ownerMetadata(head, keyId, objectKey) {
  const data = head?.Metadata;
  if (data?.project !== 'game-room' || data.format !== '1' || data['key-id'] !== keyId
    || !/^[a-f0-9]{64}$/.test(data.sha256 ?? '') || !timestamp(data.origin)
    || String(timestamp(data.origin).time) !== data['created-at']) return false;
  if (objectKey.startsWith(`${PREFIX}hourly/`)) return objectKey === `${PREFIX}hourly/${data.origin}`;
  return objectKey === `${PREFIX}daily/backup-${timestamp(data.origin).day}.sqlite`;
}
async function headObject(runAws, bucket, objectKey) {
  try { return await runAws(['s3api', 'head-object', '--bucket', bucket, '--key', objectKey]); }
  catch (error) { if (absent(error)) return null; throw error; }
}
async function upload(runAws, bucket, objectKey, path, metadata) {
  await runAws(['s3api', 'put-object', '--bucket', bucket, '--key', objectKey, '--body', path,
    '--metadata', JSON.stringify(metadata), '--if-none-match', '*', '--content-type', 'application/vnd.sqlite3',
    '--checksum-sha256', Buffer.from(metadata.sha256, 'hex').toString('base64')]);
  const saved = await headObject(runAws, bucket, objectKey);
  if (!ownerMetadata(saved, metadata['key-id'], objectKey) || saved.Metadata.sha256 !== metadata.sha256) throw new Error('Remote backup verification failed');
}
function localCandidates(directory, key) {
  const valid = []; let ignored = 0;
  for (const name of readdirSync(directory)) {
    const parsed = timestamp(name);
    if (!parsed) continue;
    const path = join(directory, name);
    try {
      if (!regularOwned(path)) throw new Error();
      const { manifest } = verifyBackup({ sourcePath: path, key });
      if (manifest.createdAt !== parsed.time) throw new Error();
      valid.push({ name, path, ...parsed });
    } catch { ignored++; }
  }
  return { valid: valid.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name)), ignored };
}
function retainedLocal(valid, current) {
  const keep = new Set(valid.filter((entry) => entry.time <= current).slice(0, 48).map((entry) => entry.name));
  const cutoff = Math.floor(current / dayMs) * dayMs - 29 * dayMs;
  const daily = new Set();
  for (const entry of valid) {
    if (entry.time > current) { keep.add(entry.name); continue; }
    if (entry.time >= cutoff && !daily.has(entry.day)) { keep.add(entry.name); daily.add(entry.day); }
  }
  return keep;
}
function pruneLocal(directory, key, current, sourcePath) {
  const { valid, ignored } = localCandidates(directory, key);
  const keep = retainedLocal(valid, current); let removed = 0;
  for (const entry of valid) if (!keep.has(entry.name)) {
    if (resolve(entry.path) === resolve(sourcePath)) continue;
    // Recheck exact ownership and signature immediately before unlink; never follow a substituted link.
    if (!regularOwned(entry.path)) continue;
    verifyBackup({ sourcePath: entry.path, key });
    unlinkSync(entry.path); removed++;
  }
  return { removed, ignored };
}
async function pruneRemote(runAws, bucket, keyId, current) {
  let removed = 0, ignored = 0;
  for (const period of ['hourly', 'daily']) {
    const prefix = `${PREFIX}${period}/`;
    const listing = await runAws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--max-keys', '1000', '--no-paginate']);
    if (listing.IsTruncated) throw new Error('Backup listing exceeded its safe retention limit');
    const candidates = [];
    for (const entry of listing.Contents ?? []) {
      if (typeof entry.Key !== 'string' || !entry.Key.startsWith(prefix)) continue;
      const name = entry.Key.slice(prefix.length);
      let parsed = period === 'hourly' ? timestamp(name) : null;
      if (period === 'daily' && /^backup-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)) {
        const day = name.slice(7, 17), time = Date.parse(`${day}T00:00:00.000Z`);
        if (Number.isFinite(time) && new Date(time).toISOString().startsWith(day)) parsed = { day, time };
      }
      if (parsed) candidates.push({ key: entry.Key, ...parsed });
    }
    candidates.sort((a, b) => b.time - a.time || b.key.localeCompare(a.key));
    const cutoff = Math.floor(current / dayMs) * dayMs - 29 * dayMs;
    const outdated = period === 'hourly' ? candidates.filter((entry) => entry.time <= current).slice(48) : candidates.filter((entry) => entry.time < cutoff);
    for (const entry of outdated) {
      if (entry.time > current) continue;
      const head = await headObject(runAws, bucket, entry.key);
      if (!ownerMetadata(head, keyId, entry.key) || typeof head.ETag !== 'string' || head.ETag.length < 3 || head.ETag.length > 128
        || /[\x00-\x20*]/.test(head.ETag)) { ignored++; continue; }
      // A replacement after HEAD fails its ETag condition instead of deleting a different object.
      await runAws(['s3api', 'delete-object', '--bucket', bucket, '--key', entry.key, '--if-match', head.ETag]); removed++;
    }
  }
  return { removed, ignored };
}
function saveStatus(directory, status) {
  const target = join(directory, 'status.json');
  try {
    lstatSync(target);
    if (!regularOwned(target) || JSON.parse(readFileSync(target, 'utf8')).project !== 'game-room') throw new Error('Unowned backup status file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.status-${randomBytes(8).toString('hex')}.json`);
  try { writeFileSync(temporary, JSON.stringify(status), { flag: 'wx', mode: 0o600 }); renameSync(temporary, target); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export async function runScheduledBackup({ env = process.env, now = Date.now, runAws, key = readStoreKey(env) } = {}) {
  if (!key) throw new Error('Scheduled backups require the existing stable key');
  const directory = backupDirectory(env.GAME_ROOM_BACKUP_DIR);
  const current = now();
  if (!Number.isSafeInteger(current) || current < 0) throw new Error('Invalid backup time');
  const name = `backup-${new Date(current).toISOString().replaceAll(':', '-').replace('.', '-')}-${randomBytes(8).toString('hex')}.sqlite`;
  const path = join(directory, name);
  const result = await backupStore({ sourcePath: env.GAME_ROOM_STORE_PATH, destinationPath: path, key, now: () => current });
  const checksum = sha(path), bucket = env.GAME_ROOM_BACKUP_BUCKET;
  let remote = false, remotePrune = { removed: 0, ignored: 0 };
  if (bucket) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Use the dedicated game-room backup bucket name');
    const invoke = runAws || awsRunner(env);
    const metadata = { project: 'game-room', format: '1', sha256: checksum, 'key-id': result.keyId, origin: name, 'created-at': String(current) };
    const hourly = `${PREFIX}hourly/${name}`;
    await upload(invoke, bucket, hourly, path, metadata);
    const daily = `${PREFIX}daily/backup-${new Date(current).toISOString().slice(0, 10)}.sqlite`;
    const existing = await headObject(invoke, bucket, daily);
    if (existing) {
      if (!ownerMetadata(existing, result.keyId, daily)) throw new Error('Existing daily backup ownership mismatch');
    } else await upload(invoke, bucket, daily, path, metadata);
    if (env.GAME_ROOM_BACKUP_PRUNE === '1') remotePrune = await pruneRemote(invoke, bucket, result.keyId, current);
    remote = true;
  }
  const localPrune = env.GAME_ROOM_BACKUP_PRUNE === '1' ? pruneLocal(directory, key, current, env.GAME_ROOM_STORE_PATH) : { removed: 0, ignored: 0 };
  const status = { project: 'game-room', format: 1, createdAt: current, filename: name, sha256: checksum,
    recordCount: result.recordCount, offsiteVerified: remote, localPrune, remotePrune };
  saveStatus(directory, status);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runScheduledBackup().then((status) => console.log(JSON.stringify(status))).catch(() => {
    console.error('Scheduled backup failed. Any completed local snapshot was retained; the success status was not advanced.');
    process.exitCode = 1;
  });
}
