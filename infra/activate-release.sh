#!/bin/bash
# Run only after approved production installation, own client/key configuration, and Linux preflight.
set -euo pipefail
umask 077
export PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ "$#" -ne 1 ] || [ "$(id -u)" -ne 0 ]; then
  echo 'Usage (root): activate-release.sh RELEASE_ID' >&2; exit 1
fi
release_id=$1
[[ "$release_id" =~ ^[a-f0-9]{20}$ ]] || exit 1
release_dir="/opt/game-room/releases/$release_id"
[[ -d "$release_dir" && ! -L "$release_dir" && -f "$release_dir/release-manifest.json" ]] || exit 1
[[ "$(stat -c %u "$release_dir")" = 0 ]] || exit 1
[[ -f /etc/game-room/runtime.env && -f /etc/game-room/store-key ]] || { echo 'Protected runtime configuration required' >&2; exit 1; }
prior=''
if [ -L /opt/game-room/current ]; then
  prior=$(readlink -f /opt/game-room/current)
  [[ "$prior" =~ ^/opt/game-room/releases/[a-f0-9]{20}$ && -d "$prior" ]] || exit 1
elif [ -e /opt/game-room/current ]; then
  echo 'Current path is not an owned release link' >&2; exit 1
fi
# Check both directions before any service stop or database write. Old manifests
# without a declaration are the known schema-1 / six-scope production baseline.
compatibility_args=("$release_dir/release-manifest.json")
if [ -n "$prior" ]; then compatibility_args+=("$prior/release-manifest.json"); fi
if ! rollback_policy=$(/opt/node/bin/node "$release_dir/scripts/release-compatibility.mjs" "${compatibility_args[@]}"); then
  echo 'Data compatibility declaration rejected; current release was not changed' >&2; exit 1
fi
case "$rollback_policy" in rollback-allowed|rollback-forbidden|initial) ;; *) echo 'Invalid activation compatibility policy; current release was not changed' >&2; exit 1 ;; esac
preflight_unit="game-room-preflight-$release_id"
systemd-run --quiet --wait --pipe --collect --unit="$preflight_unit" \
  --property=User=game-room --property=Group=game-room --property=UMask=0077 \
  --property="WorkingDirectory=$release_dir" --property=EnvironmentFile=/etc/game-room/runtime.env \
  --property=LoadCredential=store-key:/etc/game-room/store-key \
  --setenv="GAME_ROOM_STORE_KEY_FILE=/run/credentials/$preflight_unit.service/store-key" \
  /opt/node/bin/node scripts/production-preflight.mjs
systemctl stop game-room.service
if [ -n "$prior" ]; then
  # Service is stopped: this last consistent business backup includes every acknowledged pre-release move.
  if ! systemctl start game-room-backup.service; then
    systemctl start game-room.service
    echo 'Pre-release backup failed; prior service restarted without changing current' >&2; exit 1
  fi
fi
candidate="/opt/game-room/.current-$release_id-$$"
ln -s "$release_dir" "$candidate"
mv -Tf "$candidate" /opt/game-room/current
if systemctl start game-room.service && curl --fail --silent --retry 10 --retry-delay 1 --retry-connrefused --retry-all-errors --retry-max-time 20 --max-time 2 --header 'Host: game.sumomoli.com' http://127.0.0.1:4177/healthz >/dev/null; then
  echo "Activated release $release_id; complete HTTPS and real-account joint acceptance before opening Agora entry."
else
  systemctl stop game-room.service
  if [ -n "$prior" ] && [ "$rollback_policy" = rollback-allowed ]; then
    ln -s "$prior" "$candidate"
    mv -Tf "$candidate" /opt/game-room/current
    systemctl start game-room.service
    echo 'Activation failed; prior code restored with business database retained' >&2
  elif [ -n "$prior" ]; then
    echo 'Activation failed; AUTOMATIC ROLLBACK FORBIDDEN: prior release lacks required data compatibility or identity enforcement. Candidate current retained and service stopped; protected database retained. Repair with a compatible secure release.' >&2
  else
    echo 'Initial activation failed; service remains stopped; protected data retained' >&2
  fi
  exit 1
fi
