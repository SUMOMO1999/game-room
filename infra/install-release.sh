#!/bin/bash
# Prepare an immutable release only. Activation and production restart are explicit later steps.
set -euo pipefail
umask 077
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ "$#" -ne 3 ] || [ "$(id -u)" -ne 0 ]; then
  echo 'Usage (root): install-release.sh ABS_ARCHIVE SHA256 RELEASE_ID' >&2; exit 1
fi
archive=$1
expected=$2
release_id=$3
[[ "$archive" = /* && "$expected" =~ ^[a-f0-9]{64}$ && "$release_id" =~ ^[a-f0-9]{20}$ ]] || exit 1
[[ -f "$archive" && ! -L "$archive" ]] || exit 1
actual=$(sha256sum "$archive")
[[ "${actual%% *}" = "$expected" ]] || { echo 'Archive checksum mismatch' >&2; exit 1; }
release_dir="/opt/game-room/releases/$release_id"
[[ ! -e "$release_dir" && ! -L "$release_dir" ]] || { echo 'Release already exists' >&2; exit 1; }
# Reject traversal, absolute names, links and files outside the explicit distribution roots.
python3 - "$archive" "$release_id" <<'PY'
import json, sys, tarfile, hashlib, pathlib
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    names = set()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if not member.isfile() or path.is_absolute() or '..' in path.parts or member.name in names:
            raise SystemExit('Invalid release member')
        if path.parts[0] not in {'app','server','scripts','infra','package.json','package-lock.json','release-manifest.json'}:
            raise SystemExit('Unexpected release path')
        names.add(member.name)
    manifest = json.load(archive.extractfile('release-manifest.json'))
    if manifest.get('project') != 'game-room' or manifest.get('releaseId') != sys.argv[2]:
        raise SystemExit('Release identity mismatch')
    files = manifest['sourceFiles']
    if names != {entry['file'] for entry in files} | {'release-manifest.json'}:
        raise SystemExit('Release file list mismatch')
    for entry in files:
        if hashlib.sha256(archive.extractfile(entry['file']).read()).hexdigest() != entry['sha256']:
            raise SystemExit('Release content mismatch')
PY
install -d -m 0755 /opt/game-room/releases
install -d -m 0755 "$release_dir"
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$release_dir"
chmod -R u=rwX,go=rX "$release_dir"
cd "$release_dir"
# Lockfile pinned; install hooks are unnecessary for these pure-JS dependencies.
/opt/node/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R root:root "$release_dir"
# npm obeys the private installation umask; the service UID still needs to
# traverse and read every locked dependency in this secret-free code tree.
chmod -R u=rwX,go=rX "$release_dir"
echo "Prepared release $release_id. No current link or running service was changed."
