import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseSources, buildRelease } from '../scripts/build-release.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// BSD tar hides AppleDouble entries on macOS; use the raw archive member inventory
// that the Linux installer sees, rather than its display-oriented -t output.
function inspectArchive(artifact) {
  return JSON.parse(execFileSync('python3', ['-c', `
import hashlib, json, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    entries = [{'name': member.name, 'regular': member.isreg(), 'symbolicLink': member.issym(), 'hardLink': member.islnk(), 'paxHeaders': member.pax_headers,
                'sha256': hashlib.sha256(archive.extractfile(member).read()).hexdigest() if member.isreg() else None} for member in members]
    manifest_members = [member for member in members if member.name == 'release-manifest.json']
    if len(manifest_members) != 1 or not manifest_members[0].isreg():
        raise RuntimeError('Release must have one regular manifest')
    print(json.dumps({'members': entries, 'manifest': json.load(archive.extractfile(manifest_members[0]))}))
`, artifact], { encoding: 'utf8' }));
}
test('release ships only runtime files, with no internal records, synthetic login launcher or private storage', t => {
  const list = releaseSources(root);
  for (const file of list) assert.ok(!/(?:\.test\.mjs$|^\.local\/|^ops\/|^specs\/|^node_modules\/|\.env$|^scripts\/local-identity-preview\.mjs$|^app\/server\.mjs$)/.test(file), file);
  assert.ok(list.includes('server/auth.mjs')); assert.ok(list.includes('scripts/production-start.mjs'));
  for(const file of ['server/room-preview.mjs','app/rummikub-preview-client.mjs','app/twist-rules.mjs'])assert.ok(list.includes(file),file);
  const outputRoot = mkdtempSync(path.join(tmpdir(), 'game-release-')); t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const result = buildRelease({ projectRoot: root, outputRoot });
  const bytes = readFileSync(result.artifact); assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
  const archive = inspectArchive(result.artifact);
  const members = archive.members.map(member => member.name);
  assert.equal(members.length, list.length + 1);
  assert.equal(new Set(members).size, members.length);
  for (const member of archive.members) {
    assert.ok(member.regular && !member.symbolicLink && !member.hardLink, member.name);
    assert.ok(Object.keys(member.paxHeaders).every(header => !/(?:xattr|acl|fflags?)/i.test(header)), `Extended attributes are forbidden: ${member.name}`);
    assert.ok(/^[A-Za-z0-9_./-]+$/.test(member.name) && !path.isAbsolute(member.name)
      && !member.name.split('/').includes('..') && !member.name.endsWith('/'), member.name);
  }
  assert.deepEqual(new Set(members), new Set([...list, 'release-manifest.json']));
  const manifest = archive.manifest;
  assert.equal(manifest.releaseId, result.releaseId); assert.equal(manifest.containsUserData, false);
  assert.deepEqual(manifest.sourceFiles.map(entry => entry.file), list);
  for (const entry of manifest.sourceFiles) assert.equal(archive.members.find(member => member.name === entry.file).sha256, entry.sha256, entry.file);
  assert.throws(() => buildRelease({ projectRoot: root, outputRoot }), /exists/);
});
