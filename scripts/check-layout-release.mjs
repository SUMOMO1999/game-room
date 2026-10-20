import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseSources } from './build-release.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw new Error(`LAYOUT_RELEASE_BLOCKED: ${reason}`); };
const required = (value, reason) => { if (!value) fail(reason); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const layoutContractFingerprint = contract => hash(JSON.stringify(contract));

/** Inspect encoded pixels, never the screenshot suffix or a caller-supplied size. */
export function screenshotDimensions(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 33 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
    const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (!size.width || !size.height) return null;
    let offset = 8, sawPixels = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), end = offset + length + 12;
      if (end > bytes.length) return null;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT' && length > 0) sawPixels = true;
      if (type === 'IEND') return length === 0 && end === bytes.length && sawPixels ? size : null;
      offset = end;
    }
    return null;
  }
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2, frame = null, components = null, inScan = false, sawScan = false, scanHasData = false;
  while (offset < bytes.length) {
    if (inScan) {
      const next = bytes.indexOf(0xff, offset);
      if (next < 0) return null;
      scanHasData ||= next > offset;
      offset = next;
    }
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    // Entropy-coded scans escape 0xff bytes and may contain restart markers.
    if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (!inScan) return null;
      scanHasData ||= marker === 0;
      continue;
    }
    if (inScan && !scanHasData) return null;
    inScan = false;
    if (marker === 0xd9) return frame && sawScan && offset === bytes.length ? frame : null;
    if (marker === 0xd8) return null;
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (frame || length < 11) return null;
      const precision = bytes[offset + 2], height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      const count = bytes[offset + 7];
      if (!width || !height || !count || length !== 8 + 3 * count || ![8, 12, 16].includes(precision)
        || (marker === 0xc0 && precision !== 8)) return null;
      components = new Set();
      for (let i = 0; i < count; i++) {
        const start = offset + 8 + i * 3, id = bytes[start], sampling = bytes[start + 1];
        if (components.has(id) || !(sampling >> 4) || (sampling >> 4) > 4 || !(sampling & 15) || (sampling & 15) > 4 || bytes[start + 2] > 3) return null;
        components.add(id);
      }
      frame = { width, height };
    } else if (marker === 0xda) {
      if (!frame || length < 8) return null;
      const count = bytes[offset + 2], scanComponents = new Set();
      if (!count || length !== 6 + 2 * count || count > components.size) return null;
      for (let i = 0; i < count; i++) {
        const id = bytes[offset + 3 + i * 2];
        if (!components.has(id) || scanComponents.has(id)) return null;
        scanComponents.add(id);
      }
      inScan = true; sawScan = true; scanHasData = false;
    }
    offset = end;
  }
  return null;
}

/** Bind evidence to the actual public/runtime UI dependency closure, not a label. */
export function layoutSourceFingerprint(sourceRoot) {
  const entries = releaseSources(sourceRoot).filter(file => file.startsWith('app/'))
    .map(file => ({ file, sha256: hash(readFileSync(resolve(sourceRoot, file))) }));
  return hash(JSON.stringify(entries));
}

export function validateLayoutEvidence(contract, report, fingerprint, { verifyArtifact = () => false, readReview = () => null } = {}) {
  required(contract?.schema === 'game-room.layout-contract.v1' && report?.schema === 'game-room.layout-evidence.v1', 'schema');
  required(digest(fingerprint) && report.sourceFingerprint === fingerprint, 'stale or unbound UI evidence');
  const contractFingerprint = layoutContractFingerprint(contract);
  required(report.contractFingerprint === contractFingerprint, 'changed or unbound acceptance contract');
  required(report.status === 'PASS' && Array.isArray(report.unresolved) && report.unresolved.length === 0, 'failed or incomplete acceptance');
  required(Array.isArray(contract.viewports) && contract.viewports.length > 0 && Array.isArray(contract.surfaces) && contract.surfaces.length > 0, 'empty coverage contract');
  const families = new Set(['phone','tablet','desktop']);
  required(Array.isArray(contract.visualFamilies) && contract.visualFamilies.length > 0 && contract.visualFamilies.every(value => families.has(value)), 'empty/invalid visual families');
  required(contract.surfaces.every(value => typeof value.id === 'string' && Array.isArray(value.families) && value.families.length > 0 && value.families.every(family => families.has(family))), 'empty/invalid surface families');
  required(contract.viewports.every(value => Number.isInteger(value.width) && value.width > 0 && Number.isInteger(value.height) && value.height > 0 && families.has(value.family)), 'invalid viewport contract');
  required(new Set(contract.viewports.map(value=>`${value.width}x${value.height}`)).size===contract.viewports.length
    && new Set(contract.surfaces.map(value=>value.id)).size===contract.surfaces.length, 'duplicate coverage contract');
  required(Array.isArray(report.cases), 'missing measurements');
  const ids = new Set();
  for (const item of report.cases) {
    required(item && typeof item.id === 'string' && !ids.has(item.id), 'duplicate/invalid case'); ids.add(item.id);
    required(item.status === 'PASS' && item.actual?.width === item.requested?.width && item.actual?.height === item.requested?.height, `viewport mismatch: ${item.id}`);
    required(item.sourceFingerprint === fingerprint && item.contractFingerprint === contractFingerprint, `stale capture: ${item.id}`);
    required(Number.isInteger(item.actual.width) && item.actual.width > 0 && Number.isInteger(item.actual.height) && item.actual.height > 0, `invalid viewport: ${item.id}`);
    required(contract.viewports.some(size => size.width === item.actual.width && size.height === item.actual.height && size.family === item.family), `device family does not match contracted viewport: ${item.id}`);
    const metrics = item.metrics;
    required(metrics && ['documentOverflowX', 'documentOverflowY'].every(key => Number.isFinite(metrics[key]) && metrics[key] <= 1 && metrics[key] >= 0), `whole-page overflow: ${item.id}`);
    for (const key of ['clippedCritical', 'overlappingCritical', 'unreachableActions', 'missingRequired'])
      required(Array.isArray(metrics[key]) && metrics[key].length === 0, `${key}: ${item.id}`);
  }
  for (const size of contract.viewports)
    required(report.cases.some(item => item.actual.width === size.width && item.actual.height === size.height && item.matrix === true), `unmeasured viewport ${size.width}x${size.height}`);
  for (const surface of contract.surfaces) for (const size of contract.viewports.filter(size => surface.families.includes(size.family)))
    required(report.cases.some(item => item.surface === surface.id && item.family === size.family && item.actual.width === size.width && item.actual.height === size.height), `missing surface ${surface.id}/${size.family}/${size.width}x${size.height}`);
  required(Array.isArray(report.artifacts) && report.artifacts.length > 0, 'missing screenshots/reports');
  for (const artifact of report.artifacts) {
    required(typeof artifact.path === 'string' && digest(artifact.sha256), 'invalid artifact');
    const verified = verifyArtifact(artifact);
    required(verified, `artifact changed or unavailable: ${artifact.path}`);
    if (artifact.kind === 'screenshot') {
      const item = report.cases.find(value => value.id === artifact.caseId);
      required(item && item.family === artifact.family && verified.width === item.actual.width && verified.height === item.actual.height, `screenshot/measurement mismatch: ${artifact.path}`);
    }
  }
  const screenshots = report.artifacts.filter(item => item.kind === 'screenshot');
  for (const family of contract.visualFamilies)
    required(screenshots.some(item => item.family === family), `missing visual evidence: ${family}`);
  const review = report.independentReview;
  required(review?.status === 'PASS' && review.sourceFingerprint === fingerprint && typeof review.reviewer === 'string'
    && review.reviewer !== report.executor && Array.isArray(review.blockers) && review.blockers.length === 0
    && report.artifacts.some(item => item.kind === 'independent-review' && item.path === review.path), 'independent review missing or failed');
  const actualReview = readReview(review.path);
  required(actualReview?.status === 'PASS' && actualReview.sourceFingerprint === fingerprint && actualReview.contractFingerprint === contractFingerprint && actualReview.reviewer === review.reviewer
    && Array.isArray(actualReview.blockers) && actualReview.blockers.length === 0
    && Array.isArray(actualReview.reviewedArtifacts) && report.artifacts.filter(item => item.kind === 'screenshot').every(item => actualReview.reviewedArtifacts.some(seen => seen.caseId === item.caseId && seen.path === item.path && seen.sha256 === item.sha256)), 'independent review file contradicts acceptance');
  required(Array.isArray(report.limitations), 'device evidence boundary missing');
  return { status: 'PASS', sourceFingerprint: fingerprint, contractFingerprint, measuredCases: report.cases.length,
    requiredViewports: contract.viewports.length, requiredSurfaces: contract.surfaces.length,
    artifacts: report.artifacts.length, physicalAcceptance: report.physicalAcceptance === true };
}

export function checkLayoutRelease(sourceRoot, contractPath, reportPath) {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  return validateLayoutEvidence(contract, report, layoutSourceFingerprint(sourceRoot), { verifyArtifact(artifact) {
    const file = resolve(dirname(reportPath), artifact.path);
    try {
      if (!statSync(file).isFile()) return false;
      const bytes = readFileSync(file);
      if (hash(bytes) !== artifact.sha256) return false;
      if (artifact.kind !== 'screenshot') return true;
      return screenshotDimensions(bytes);
    } catch { return false; }
  }, readReview(path) { try { return JSON.parse(readFileSync(resolve(dirname(reportPath),path),'utf8')); } catch { return null; } } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    required(process.argv.length === 5, 'usage: SOURCE_ROOT CONTRACT REPORT');
    console.log(JSON.stringify(checkLayoutRelease(...process.argv.slice(2).map(value => resolve(value)))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
