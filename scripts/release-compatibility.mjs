import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY_SCOPES = ['game-profiles', 'room-invites', 'rooms', 'room-memberships', 'room-registry', 'room-requests'];
const CURRENT_SCOPES = [...LEGACY_SCOPES, 'room-chat', 'game-history', 'history-index', 'wordbank-packs', 'wordbank-releases', 'wordbank-index', 'draw-canvases',
  'game-score-ledger', 'game-score-balances', 'game-score-meta', 'hyakki-events', 'hyakki-event-meta'];
const LEGACY = { format: 1, roomSnapshots: { read: [1], write: [1] },
  backupScopes: { read: LEGACY_SCOPES, write: LEGACY_SCOPES } };

// This declaration covers persistent room snapshots and the business backup /
// recovery tools shipped with the same current link. Auth/presence stays ephemeral.
export const CURRENT_DATA_COMPATIBILITY = Object.freeze({ format: 1,
  roomSnapshots: Object.freeze({ read: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), write: Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) }),
  backupScopes: Object.freeze({ read: Object.freeze([...CURRENT_SCOPES]), write: Object.freeze([...CURRENT_SCOPES]) }) });

const invalid = (reason) => { throw new Error(`DATA_COMPATIBILITY_INVALID: ${reason}`); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, expected) {
  if (!object(value) || Object.keys(value).length !== expected.length
      || Object.keys(value).some((key) => !expected.includes(key))) invalid('declaration fields');
}
function list(value, valid) {
  if (!Array.isArray(value) || !value.length || value.length > 32
      || new Set(value).size !== value.length || value.some((entry) => !valid(entry))) invalid('capability list');
}
const includes = (read, write) => write.every((value) => read.includes(value));

export function validateDataCompatibility(value) {
  keys(value, ['format', 'roomSnapshots', 'backupScopes']);
  if (value.format !== 1) invalid('unsupported declaration format');
  keys(value.roomSnapshots, ['read', 'write']); keys(value.backupScopes, ['read', 'write']);
  for (const direction of ['read', 'write']) {
    list(value.roomSnapshots[direction], (entry) => Number.isSafeInteger(entry) && entry >= 1 && entry <= 32);
    list(value.backupScopes[direction], (entry) => typeof entry === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(entry));
  }
  if (!includes(value.roomSnapshots.read, value.roomSnapshots.write)
      || !includes(value.backupScopes.read, value.backupScopes.write)) invalid('release cannot read its own writes');
  return structuredClone(value);
}

function manifestCapabilities(manifest, { allowLegacy = false } = {}) {
  if (!object(manifest) || manifest.format !== 1 || manifest.project !== 'game-room'
      || !/^[a-f0-9]{20}$/.test(manifest.releaseId ?? '')
      || manifest.containsSecrets !== false || manifest.containsUserData !== false) invalid('release manifest');
  if (!Object.hasOwn(manifest, 'dataCompatibility')) {
    if (!allowLegacy) invalid('candidate declaration is required');
    return { capabilities: structuredClone(LEGACY), legacy: true };
  }
  return { capabilities: validateDataCompatibility(manifest.dataCompatibility), legacy: false };
}

/** Validate before switching current. Unknown prior declarations are never trusted. */
export function compareReleaseCompatibility(candidateManifest, priorManifest = null) {
  const candidate = manifestCapabilities(candidateManifest);
  if (priorManifest === null) return { forwardCompatible: true, rollbackCompatible: false, initial: true, priorLegacy: false };
  const prior = manifestCapabilities(priorManifest, { allowLegacy: true });
  const readable = (reader, writer) => includes(reader.roomSnapshots.read, writer.roomSnapshots.write)
    && includes(reader.backupScopes.read, writer.backupScopes.write);
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
