import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY_SCOPES = ['game-profiles', 'room-invites', 'rooms', 'room-memberships', 'room-registry', 'room-requests'];
const CURRENT_SCOPES = [...LEGACY_SCOPES, 'room-chat', 'game-history', 'history-index', 'wordbank-packs', 'wordbank-releases', 'wordbank-index', 'draw-canvases',
  'game-score-ledger', 'game-score-balances', 'game-score-meta', 'hyakki-events', 'hyakki-event-meta'];
const LEGACY = { format: 1, roomSnapshots: { read: [1], write: [1] },
  backupScopes: { read: LEGACY_SCOPES, write: LEGACY_SCOPES } };

// Schema19 keeps skipped turns; old drawing binaries must not
// be selected after new drawing snapshots are written. Other games keep their versions.
// This declaration covers persistent room snapshots and the business backup /
// recovery tools shipped with the same current link. Auth/presence stays ephemeral.
// Schema20 pins Rummikub friends-v5; older binaries cannot read its snapshots.
// Schema21 pins Hyakki's player-count content; legacy snapshots stay readable.
export const CURRENT_DATA_COMPATIBILITY = Object.freeze({ format: 1,
  roomSnapshots: Object.freeze({ read: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21]), write: Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 17, 18, 19, 20, 21]) }),
  backupScopes: Object.freeze({ read: Object.freeze([...CURRENT_SCOPES]), write: Object.freeze([...CURRENT_SCOPES]) }),
  // Snapshot schema1 is unchanged, but a 5000-word reader rejects a valid new
  // shared pack. Capacity is therefore part of binary activation compatibility.
  wordbankSharedWords: Object.freeze({ read: 20000, write: 20000 }),
  wordbankSharedBytes: Object.freeze({ read: 8 * 1024 * 1024, write: 8 * 1024 * 1024 }),
  // A schema1 canvas may now retain one whole stroke up to the existing
  // 50,000-point canvas budget. Historical readers reject more than 4096.
  canvasStrokePoints: Object.freeze({ read: 50000, write: 50000 }),
  // Snapshot/backup scope names do not change when public event groups gain
  // trusted turn/delta metadata. Group3 additionally pins content/count;
  // every group retains the measured 32 KiB ceiling and original reserve.
  hyakkiEvents: Object.freeze({ read: Object.freeze([1, 2, 3]), write: Object.freeze([2, 3]) }),
  // Zero means the historical practice envelope without a public journal.
  // Pausing an untouched old save can still write that exact legacy shape.
  hyakkiPracticeJournal: Object.freeze({ read: Object.freeze([0, 1]), write: Object.freeze([0, 1]) }),
  hyakkiPracticeSaveBytes: Object.freeze({ read: 9 * 1024 * 1024, write: 9 * 1024 * 1024 }) });

const invalid = (reason) => { throw new Error(`DATA_COMPATIBILITY_INVALID: ${reason}`); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, expected, optional = []) {
  if (!object(value) || expected.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !expected.includes(key) && !optional.includes(key))) invalid('declaration fields');
}
function list(value, valid) {
  if (!Array.isArray(value) || !value.length || value.length > 32
      || new Set(value).size !== value.length || value.some((entry) => !valid(entry))) invalid('capability list');
}
const includes = (read, write) => write.every((value) => read.includes(value));

export function validateDataCompatibility(value) {
  keys(value, ['format', 'roomSnapshots', 'backupScopes'], ['wordbankSharedWords', 'wordbankSharedBytes','canvasStrokePoints', 'hyakkiEvents', 'hyakkiPracticeJournal', 'hyakkiPracticeSaveBytes']);
  if (value.format !== 1) invalid('unsupported declaration format');
  keys(value.roomSnapshots, ['read', 'write']); keys(value.backupScopes, ['read', 'write']);
  for (const direction of ['read', 'write']) {
    list(value.roomSnapshots[direction], (entry) => Number.isSafeInteger(entry) && entry >= 1 && entry <= 32);
    list(value.backupScopes[direction], (entry) => typeof entry === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(entry));
  }
  if (!includes(value.roomSnapshots.read, value.roomSnapshots.write)
      || !includes(value.backupScopes.read, value.backupScopes.write)) invalid('release cannot read its own writes');
  // Historical declarations predate this field. Their deployed content reader
  // and writer were both bounded at 5000; absence must never imply unlimited.
  const wordbankSharedWords = Object.hasOwn(value, 'wordbankSharedWords') ? value.wordbankSharedWords : { read: 5000, write: 5000 };
  keys(wordbankSharedWords, ['read', 'write']);
  if (['read', 'write'].some(direction => !Number.isSafeInteger(wordbankSharedWords[direction]) || wordbankSharedWords[direction] < 1)) invalid('wordbank capacity');
  if (wordbankSharedWords.read < wordbankSharedWords.write) invalid('release cannot read its own wordbank writes');
  // Historical shared snapshots were capped at 4 MiB. Schema1 alone cannot
  // make a smaller reader safe after a larger content pack has been stored.
  const wordbankSharedBytes = Object.hasOwn(value, 'wordbankSharedBytes') ? value.wordbankSharedBytes : { read: 4 * 1024 * 1024, write: 4 * 1024 * 1024 };
  keys(wordbankSharedBytes, ['read', 'write']);
  if (['read', 'write'].some(direction => !Number.isSafeInteger(wordbankSharedBytes[direction]) || wordbankSharedBytes[direction] < 1)) invalid('wordbank bytes');
  if (wordbankSharedBytes.read < wordbankSharedBytes.write) invalid('release cannot read its own wordbank bytes');
  const canvasStrokePoints = Object.hasOwn(value, 'canvasStrokePoints') ? value.canvasStrokePoints : { read: 4096, write: 4096 };
  keys(canvasStrokePoints, ['read', 'write']);
  if (['read', 'write'].some(direction => !Number.isSafeInteger(canvasStrokePoints[direction]) || canvasStrokePoints[direction] < 1)) invalid('canvas stroke points');
  if (canvasStrokePoints.read < canvasStrokePoints.write) invalid('release cannot read its own canvas stroke writes');
  const hyakkiEvents = Object.hasOwn(value, 'hyakkiEvents') ? value.hyakkiEvents : { read: [1], write: [1] };
  const hyakkiPracticeJournal = Object.hasOwn(value, 'hyakkiPracticeJournal') ? value.hyakkiPracticeJournal : { read: [0], write: [0] };
  for (const [capability, minimum, maximum] of [[hyakkiEvents, 1, 3], [hyakkiPracticeJournal, 0, 1]]) {
    keys(capability, ['read', 'write']);
    for (const direction of ['read', 'write']) list(capability[direction], entry => Number.isSafeInteger(entry) && entry >= minimum && entry <= maximum);
    if (!includes(capability.read, capability.write)) invalid('release cannot read its own hyakki writes');
  }
  const hyakkiPracticeSaveBytes = Object.hasOwn(value, 'hyakkiPracticeSaveBytes') ? value.hyakkiPracticeSaveBytes : { read: 524288, write: 524288 };
  keys(hyakkiPracticeSaveBytes, ['read', 'write']);
  if (['read', 'write'].some(direction => !Number.isSafeInteger(hyakkiPracticeSaveBytes[direction]) || hyakkiPracticeSaveBytes[direction] < 1)
      || hyakkiPracticeSaveBytes.read < hyakkiPracticeSaveBytes.write) invalid('hyakki practice bytes');
  return { ...structuredClone(value), hyakkiEvents: structuredClone(hyakkiEvents), hyakkiPracticeJournal: structuredClone(hyakkiPracticeJournal),
    hyakkiPracticeSaveBytes: structuredClone(hyakkiPracticeSaveBytes), wordbankSharedWords: structuredClone(wordbankSharedWords), wordbankSharedBytes: structuredClone(wordbankSharedBytes),
    canvasStrokePoints: structuredClone(canvasStrokePoints) };
}

function manifestCapabilities(manifest, { allowLegacy = false } = {}) {
  if (!object(manifest) || manifest.format !== 1 || manifest.project !== 'game-room'
      || !/^[a-f0-9]{20}$/.test(manifest.releaseId ?? '')
      || manifest.containsSecrets !== false || manifest.containsUserData !== false) invalid('release manifest');
  if (!Object.hasOwn(manifest, 'dataCompatibility')) {
    if (!allowLegacy) invalid('candidate declaration is required');
    return { capabilities: validateDataCompatibility(LEGACY), legacy: true };
  }
  return { capabilities: validateDataCompatibility(manifest.dataCompatibility), legacy: false };
}

/** Validate before switching current. Unknown prior declarations are never trusted. */
export function compareReleaseCompatibility(candidateManifest, priorManifest = null) {
  const candidate = manifestCapabilities(candidateManifest);
  if (priorManifest === null) return { forwardCompatible: true, rollbackCompatible: false, initial: true, priorLegacy: false };
  const prior = manifestCapabilities(priorManifest, { allowLegacy: true });
  const readable = (reader, writer) => includes(reader.roomSnapshots.read, writer.roomSnapshots.write)
    && includes(reader.backupScopes.read, writer.backupScopes.write)
    && reader.wordbankSharedWords.read >= writer.wordbankSharedWords.write
    && reader.wordbankSharedBytes.read >= writer.wordbankSharedBytes.write
    && reader.canvasStrokePoints.read >= writer.canvasStrokePoints.write
    && includes(reader.hyakkiEvents.read, writer.hyakkiEvents.write)
    && includes(reader.hyakkiPracticeJournal.read, writer.hyakkiPracticeJournal.write)
    && reader.hyakkiPracticeSaveBytes.read >= writer.hyakkiPracticeSaveBytes.write;
  return { forwardCompatible: readable(candidate.capabilities, prior.capabilities),
    rollbackCompatible: readable(prior.capabilities, candidate.capabilities), initial: false, priorLegacy: prior.legacy };
}

function readManifest(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid('manifest must be a regular file');
  if (stat.size > 1024 * 1024) invalid('manifest size');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function activationPolicy(candidatePath, priorPath) {
  const candidate=readManifest(candidatePath),prior=priorPath===undefined?null:readManifest(priorPath);
  for(const value of [candidate,prior]) if(value && value.identityPolicy!==undefined && value.identityPolicy!=='agora-account-security-v1') invalid('unknown identity policy');
  if(prior?.identityPolicy && !candidate.identityPolicy) throw new Error('CANDIDATE_IDENTITY_POLICY_DOWNGRADE: candidate lacks current shared identity enforcement');
  const result = compareReleaseCompatibility(candidate,prior);
  if (!result.forwardCompatible) throw new Error('CANDIDATE_DATA_INCOMPATIBLE: candidate cannot read data written by current release');
  return result.initial ? 'initial' : result.rollbackCompatible && (!candidate.identityPolicy || prior.identityPolicy===candidate.identityPolicy) ? 'rollback-allowed' : 'rollback-forbidden';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (![3, 4].includes(process.argv.length)) throw new Error('Usage: release-compatibility.mjs CANDIDATE_MANIFEST [PRIOR_MANIFEST]');
    console.log(activationPolicy(process.argv[2], process.argv[3]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
