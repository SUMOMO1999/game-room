#!/bin/bash
# Run only after approved production installation and own client/key configuration.
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
preflight_credentials=(--property=LoadCredential=store-key:/etc/game-room/store-key
  "--setenv=GAME_ROOM_STORE_KEY_FILE=/run/credentials/$preflight_unit.service/store-key")
identity_key=/etc/game-room/identity-batch-key
# A separately approved caller key may be installed later. Its presence is not
# central readiness: the existing feature flag still controls batch use.
if [ -e "$identity_key" ] || [ -L "$identity_key" ]; then
  [[ -f "$identity_key" && ! -L "$identity_key" ]] || { echo 'Invalid identity signing-key source' >&2; exit 1; }
  identity_key_info=$(stat -c '%u:%a' "$identity_key")
  case "$identity_key_info" in 0:400|0:600) ;; *) echo 'Identity signing key must be a root-private file' >&2; exit 1 ;; esac
  preflight_credentials+=("--property=LoadCredential=identity-batch-key:$identity_key"
    "--setenv=GAME_ROOM_IDENTITY_BATCH_KEY_FILE=/run/credentials/$preflight_unit.service/identity-batch-key")
fi
# Starting an already-running oneshot joins its existing invocation. Do not
# mistake a timer's pre-stop snapshot for this release's final business backup.
read_backup_state() {
  local properties key value
  properties=$(systemctl show --property=ActiveState --property=InvocationID --property=Result game-room-backup.service) || return 1
  backup_active='' backup_invocation='' backup_result=''
  while IFS='=' read -r key value; do
    case "$key" in
      ActiveState) backup_active=$value ;;
      InvocationID) backup_invocation=$value ;;
      Result) backup_result=$value ;;
      *) return 1 ;;
    esac
  done <<< "$properties"
  [[ -n "$backup_active" && "$backup_result" =~ ^[a-z-]+$ ]] || return 1
  [[ -z "$backup_invocation" || "$backup_invocation" =~ ^[a-f0-9]{32}$ ]] || return 1
}
wait_backup_finished() {
  local deadline=$((SECONDS + $1))
  while :; do
    read_backup_state || return 1
    case "$backup_active" in
      inactive|failed) return 0 ;;
      active|activating|reloading|deactivating) ;;
      *) return 1 ;;
    esac
    if (( SECONDS >= deadline )); then return 1; fi
    sleep 1 || return 1
  done
}
wait_new_backup_finished() {
  local previous_invocation=$1 deadline=$((SECONDS + $2))
  while :; do
    read_backup_state || return 1
    case "$backup_active" in
      inactive|failed|active|activating|reloading|deactivating) ;;
      *) return 1 ;;
    esac
    # --no-block can return before systemd has begun the queued job. The old
    # inactive (or failed) invocation is not this release's completed backup.
    if [[ -n "$backup_invocation" && "$backup_invocation" != 00000000000000000000000000000000
      && "$backup_invocation" != "$previous_invocation" ]]; then
      case "$backup_active" in
        inactive) [[ "$backup_result" = success ]] || return 1; return 0 ;;
        failed) return 1 ;;
      esac
    fi
    if (( SECONDS >= deadline )); then return 1; fi
    sleep 1 || return 1
  done
}
final_old_backup() {
  local previous_invocation
  wait_backup_finished 60 || return 1
  previous_invocation=$backup_invocation
  systemctl start --no-block game-room-backup.service || return 1
  wait_new_backup_finished "$previous_invocation" 300 || return 1
  echo "Final stopped-service backup confirmed: $backup_invocation"
}
systemctl stop game-room.service
if [ -n "$prior" ]; then
  # Drain an old timer invocation without killing it, then require a distinct
  # completed invocation while prior code still owns the unchanged database.
  if ! final_old_backup; then
    systemctl start game-room.service
    echo 'Pre-release backup failed; prior service restarted without changing current' >&2; exit 1
  fi
fi
candidate="/opt/game-room/.current-$release_id-$$"
ln -s "$release_dir" "$candidate"
mv -Tf "$candidate" /opt/game-room/current
# Candidate preflight can initialize new business scopes. It must run only
# after the old service stopped and its own tools saved the final backup.
# Preflight failure shares the same compatibility guard as start/health failure.
if systemd-run --quiet --wait --pipe --collect --unit="$preflight_unit" \
    --property=User=game-room --property=Group=game-room --property=UMask=0077 \
    --property="WorkingDirectory=$release_dir" --property=EnvironmentFile=/etc/game-room/runtime.env \
    "${preflight_credentials[@]}" \
    /opt/node/bin/node scripts/production-preflight.mjs \
  && systemctl start game-room.service \
  && curl --fail --silent --retry 10 --retry-delay 1 --retry-connrefused --retry-all-errors --retry-max-time 20 --max-time 2 --header 'Host: game.sumomoli.com' http://127.0.0.1:4177/healthz >/dev/null; then
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
