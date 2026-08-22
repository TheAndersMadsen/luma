#!/usr/bin/env bash
# Install the cleartext connectivity vhost as a manifest-backed transaction.
set -euo pipefail
umask 077

usage() { printf 'usage: %s --source FILE --backup-dir DIR [--nginx-stopped]\n' "$0" >&2; exit 64; }

source_file=""
backup_dir=""
nginx_stopped=0
while (($#)); do
  case "$1" in
    --source) (($# >= 2)) || usage; source_file="$2"; shift 2 ;;
    --backup-dir) (($# >= 2)) || usage; backup_dir="$2"; shift 2 ;;
    --nginx-stopped) nginx_stopped=1; shift ;;
    *) usage ;;
  esac
done
[[ -f "$source_file" && ! -L "$source_file" && -n "$backup_dir" ]] || usage

# Resolve the evidence path before creating anything.  This rejects traversal and
# symlink escapes while retaining the existing CLI contract.
backup_dir="$(realpath -m -- "$backup_dir")"
case "$backup_dir" in
  /home/anders/ai-pin-revival/backups/*|/home/anders/ai-pin-revival/deployments/*) ;;
  *) echo "refusing unexpected rollback-evidence directory" >&2; exit 1 ;;
esac
if [[ -e "$backup_dir" && ( ! -d "$backup_dir" || -L "$backup_dir" ) ]]; then
  echo "refusing non-directory or symlink rollback-evidence path" >&2
  exit 1
fi
mkdir -p -- "$backup_dir"
[[ "$(realpath -e -- "$backup_dir")" == "$backup_dir" ]] || {
  echo "rollback-evidence directory changed while being prepared" >&2
  exit 1
}

available=/etc/nginx/sites-available/ai-pin-revival-connectivity
enabled=/etc/nginx/sites-enabled/ai-pin-revival-connectivity
install_dir="$backup_dir/nginx-install"
snapshot_dir="$install_dir/snapshot"
presence_manifest="$snapshot_dir/PRESENCE.COMPLETE"
install_marker="$install_dir/INSTALL.COMPLETE"

if [[ -e "$install_dir" && ( ! -d "$install_dir" || -L "$install_dir" ) ]]; then
  echo "refusing non-directory or symlink nginx transaction directory" >&2
  exit 1
fi
mkdir -p -- "$install_dir"
chmod 700 -- "$install_dir"

staging_dir=""
marker_tmp=""
available_candidate="${available}.ai-pin-revival-candidate.$$"
enabled_candidate="${enabled}.ai-pin-revival-candidate.$$"
available_restore="${available}.ai-pin-revival-restore.$$"
enabled_restore="${enabled}.ai-pin-revival-restore.$$"
mutation_armed=0
transaction_committed=0

object_type() {
  local path="$1"
  if sudo -n test -L "$path"; then
    printf 'symlink\n'
  elif sudo -n test -f "$path"; then
    printf 'regular\n'
  elif ! sudo -n test -e "$path" && ! sudo -n test -L "$path"; then
    printf 'absent\n'
  else
    printf 'unsupported\n'
    return 1
  fi
}

# Fingerprint the state cp -a is expected to preserve: type, mode, ownership,
# size, mtime, and either content or the exact symlink payload.
object_identity() {
  local path="$1"
  local type="$2"
  case "$type" in
    regular)
      {
        printf 'regular\0'
        sudo -n stat --printf='%f\0%u\0%g\0%s\0%Y\0' -- "$path"
        sudo -n sha256sum -- "$path" | awk '{printf "%s%c", $1, 0}'
      } | sha256sum | awk '{print $1}'
      ;;
    symlink)
      {
        printf 'symlink\0'
        sudo -n stat --printf='%f\0%u\0%g\0%s\0%Y\0' -- "$path"
        sudo -n readlink -z -- "$path"
      } | sha256sum | awk '{print $1}'
      ;;
    *) return 1 ;;
  esac
}

manifest_value() {
  local key="$1"
  awk -F '\t' -v wanted="$key" '
    $1 == wanted { if (found) exit 2; value=$2; found=1 }
    END { if (!found) exit 3; print value }
  ' "$presence_manifest"
}

validate_manifest_entry() {
  local label="$1"
  local target="$2"
  local expected_snapshot="$3"
  local manifest_target present type snapshot identity actual_type actual_identity

  manifest_target="$(manifest_value "$label.target")" || return 1
  present="$(manifest_value "$label.present")" || return 1
  type="$(manifest_value "$label.type")" || return 1
  snapshot="$(manifest_value "$label.snapshot")" || return 1
  identity="$(manifest_value "$label.identity_sha256")" || return 1
  [[ "$manifest_target" == "$target" ]] || return 1

  case "$present:$type:$snapshot" in
    0:absent:-)
      [[ "$identity" == "-" ]] || return 1
      [[ ! -e "$snapshot_dir/$expected_snapshot" && ! -L "$snapshot_dir/$expected_snapshot" ]] || return 1
      ;;
    1:regular:"$expected_snapshot"|1:symlink:"$expected_snapshot")
      [[ "$identity" =~ ^[0-9a-f]{64}$ ]] || return 1
      actual_type="$(object_type "$snapshot_dir/$expected_snapshot")" || return 1
      [[ "$actual_type" == "$type" ]] || return 1
      actual_identity="$(object_identity "$snapshot_dir/$expected_snapshot" "$type")" || return 1
      [[ "$actual_identity" == "$identity" ]] || return 1
      ;;
    *) return 1 ;;
  esac
}

validate_completed_snapshot() {
  [[ -d "$snapshot_dir" && ! -L "$snapshot_dir" ]] || return 1
  [[ -f "$presence_manifest" && ! -L "$presence_manifest" ]] || return 1
  [[ "$(wc -l < "$presence_manifest" | tr -d ' ')" == 12 ]] || return 1
  [[ "$(manifest_value schema)" == "ai-pin-revival-nginx-presence-v1" ]] || return 1
  [[ "$(manifest_value complete)" == "1" ]] || return 1
  validate_manifest_entry available "$available" available.before || return 1
  validate_manifest_entry enabled "$enabled" enabled.before || return 1
}

validate_live_entry_matches_snapshot() {
  local label="$1"
  local target="$2"
  local present type identity actual_type actual_identity
  present="$(manifest_value "$label.present")" || return 1
  type="$(manifest_value "$label.type")" || return 1
  identity="$(manifest_value "$label.identity_sha256")" || return 1
  actual_type="$(object_type "$target")" || return 1
  if [[ "$present" == "0" ]]; then
    [[ "$actual_type" == "absent" ]] || return 1
    return 0
  fi
  [[ "$actual_type" == "$type" ]] || return 1
  actual_identity="$(object_identity "$target" "$type")" || return 1
  [[ "$actual_identity" == "$identity" ]]
}

validate_live_state_matches_snapshot() {
  validate_live_entry_matches_snapshot available "$available" || return 1
  validate_live_entry_matches_snapshot enabled "$enabled" || return 1
}

capture_entry() {
  local label="$1"
  local target="$2"
  local snapshot_name="$3"
  local manifest_tmp="$4"
  local type live_identity snapshot_identity

  type="$(object_type "$target")" || {
    echo "refusing unsupported object at $target" >&2
    return 1
  }
  printf '%s.target\t%s\n' "$label" "$target" >> "$manifest_tmp"
  if [[ "$type" == "absent" ]]; then
    printf '%s.present\t0\n%s.type\tabsent\n%s.snapshot\t-\n%s.identity_sha256\t-\n' \
      "$label" "$label" "$label" "$label" >> "$manifest_tmp"
    return 0
  fi

  sudo -n cp -a -- "$target" "$staging_dir/$snapshot_name"
  [[ "$(object_type "$staging_dir/$snapshot_name")" == "$type" ]] || return 1
  live_identity="$(object_identity "$target" "$type")" || return 1
  snapshot_identity="$(object_identity "$staging_dir/$snapshot_name" "$type")" || return 1
  [[ "$live_identity" == "$snapshot_identity" ]] || {
    echo "nginx state changed while $label was being captured" >&2
    return 1
  }
  printf '%s.present\t1\n%s.type\t%s\n%s.snapshot\t%s\n%s.identity_sha256\t%s\n' \
    "$label" "$label" "$type" "$label" "$snapshot_name" "$label" "$snapshot_identity" \
    >> "$manifest_tmp"
}

create_completed_snapshot() {
  local manifest_tmp
  [[ ! -e "$snapshot_dir" && ! -L "$snapshot_dir" ]] || return 1
  staging_dir="$(mktemp -d "$install_dir/.snapshot-staging.XXXXXX")"
  chmod 700 -- "$staging_dir"
  manifest_tmp="$staging_dir/.PRESENCE.COMPLETE.tmp"
  printf 'schema\tai-pin-revival-nginx-presence-v1\n' > "$manifest_tmp"
  capture_entry available "$available" available.before "$manifest_tmp"
  capture_entry enabled "$enabled" enabled.before "$manifest_tmp"
  printf 'complete\t1\n' >> "$manifest_tmp"
  chmod 400 -- "$manifest_tmp"
  mv -- "$manifest_tmp" "$staging_dir/PRESENCE.COMPLETE"
  mv -- "$staging_dir" "$snapshot_dir"
  staging_dir=""
  validate_completed_snapshot
}

restore_entry() {
  local label="$1"
  local target="$2"
  local restore_path="$3"
  local expected_snapshot="$4"
  local present type identity restored_type restored_identity

  present="$(manifest_value "$label.present")" || return 1
  type="$(manifest_value "$label.type")" || return 1
  identity="$(manifest_value "$label.identity_sha256")" || return 1
  sudo -n rm -f -- "$restore_path" || return 1

  if [[ "$present" == "0" ]]; then
    sudo -n rm -f -- "$target" || return 1
    [[ "$(object_type "$target")" == "absent" ]] || return 1
    return 0
  fi

  sudo -n cp -a -- "$snapshot_dir/$expected_snapshot" "$restore_path" || return 1
  restored_type="$(object_type "$restore_path")" || return 1
  [[ "$restored_type" == "$type" ]] || return 1
  restored_identity="$(object_identity "$restore_path" "$type")" || return 1
  [[ "$restored_identity" == "$identity" ]] || return 1
  sudo -n mv -Tf -- "$restore_path" "$target" || return 1
  restored_type="$(object_type "$target")" || return 1
  [[ "$restored_type" == "$type" ]] || return 1
  restored_identity="$(object_identity "$target" "$type")" || return 1
  [[ "$restored_identity" == "$identity" ]] || return 1
}

restore_completed_snapshot() {
  validate_completed_snapshot || {
    echo "refusing nginx rollback without a valid completed presence manifest: $presence_manifest" >&2
    return 1
  }
  sudo -n rm -f -- "$available_candidate" "$enabled_candidate" || return 1
  restore_entry available "$available" "$available_restore" available.before || return 1
  restore_entry enabled "$enabled" "$enabled_restore" enabled.before || return 1
  sudo -n nginx -t >/dev/null || return 1
  if ((nginx_stopped == 0)); then sudo -n systemctl reload nginx || return 1; fi
}

cleanup_transients() {
  local failed=0
  if [[ -n "$staging_dir" ]]; then
    case "$staging_dir" in
      "$install_dir"/.snapshot-staging.*)
        sudo -n rm -rf -- "$staging_dir" || failed=1
        ;;
      *) failed=1 ;;
    esac
  fi
  if [[ -n "$marker_tmp" ]]; then
    case "$marker_tmp" in
      "$install_dir"/.INSTALL.COMPLETE.*)
        rm -f -- "$marker_tmp" || failed=1
        ;;
      *) failed=1 ;;
    esac
  fi
  sudo -n rm -f -- "$available_candidate" "$enabled_candidate" \
    "$available_restore" "$enabled_restore" || failed=1
  return "$failed"
}

fail_transaction() {
  local status="${1:-1}"
  trap - ERR HUP INT TERM
  if ((mutation_armed && ! transaction_committed)); then
    if ! rm -f -- "$install_marker"; then
      echo "CRITICAL: nginx transaction success marker could not be cleared" >&2
      status=70
    fi
    if ! restore_completed_snapshot; then
      echo "CRITICAL: nginx transaction failed and exact rollback did not complete" >&2
      status=70
    fi
  fi
  if ! cleanup_transients; then
    echo "CRITICAL: nginx transaction temporary cleanup did not complete" >&2
    status=70
  fi
  exit "$status"
}

signal_transaction() {
  local signal="$1"
  local status="$2"
  echo "received $signal during nginx transaction" >&2
  fail_transaction "$status"
}

trap 'fail_transaction $?' ERR
trap 'signal_transaction HUP 129' HUP
trap 'signal_transaction INT 130' INT
trap 'signal_transaction TERM 143' TERM

if [[ -e "$snapshot_dir" || -L "$snapshot_dir" ]]; then
  validate_completed_snapshot || {
    echo "refusing incomplete or invalid existing nginx snapshot: $snapshot_dir" >&2
    exit 1
  }
else
  create_completed_snapshot
fi

# The manifest above is the sole authority for presence.  An absent artifact is
# never treated as evidence that the original target was absent.
validate_completed_snapshot
validate_live_state_matches_snapshot || {
  echo "refusing nginx mutation because live state no longer matches the completed snapshot" >&2
  exit 1
}
rm -f -- "$install_marker"
mutation_armed=1

sudo -n rm -f -- "$available_candidate" "$enabled_candidate" \
  "$available_restore" "$enabled_restore"
sudo -n install -o root -g root -m 644 -- "$source_file" "$available_candidate"
sudo -n mv -Tf -- "$available_candidate" "$available"
sudo -n ln -s -- "$available" "$enabled_candidate"
sudo -n mv -Tf -- "$enabled_candidate" "$enabled"
sudo -n nginx -t >/dev/null
if ((nginx_stopped == 0)); then sudo -n systemctl reload nginx; fi

if ((nginx_stopped == 0)); then
  for host in connectivity-check.carry.humane.cloud n.carry.humane.cloud; do
    [[ "$(curl --silent --show-error --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $host" http://127.0.0.1/)" == 204 ]]
    [[ "$(curl --silent --show-error --max-time 5 -I -o /dev/null -w '%{http_code}' -H "Host: $host" http://127.0.0.1/)" == 204 ]]
    [[ "$(curl --silent --show-error --max-time 5 -X POST -o /dev/null -w '%{http_code}' -H "Host: $host" http://127.0.0.1/)" == 405 ]]
    [[ "$(curl --silent --show-error --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $host" http://127.0.0.1/not-a-connectivity-check)" == 404 ]]
  done
fi

marker_tmp="$(mktemp "$install_dir/.INSTALL.COMPLETE.XXXXXX")"
{
  printf 'schema\tai-pin-revival-nginx-install-v1\n'
  printf 'presence_manifest\tsnapshot/PRESENCE.COMPLETE\n'
  printf 'available\t%s\n' "$available"
  printf 'enabled\t%s\n' "$enabled"
  printf 'complete\t1\n'
} > "$marker_tmp"
chmod 400 -- "$marker_tmp"
mv -- "$marker_tmp" "$install_marker"
marker_tmp=""

transaction_committed=1
mutation_armed=0
trap - ERR HUP INT TERM
cleanup_transients

printf 'installed and verified cleartext connectivity vhost\n'
printf 'presence_manifest=%s\n' "$presence_manifest"
printf 'install_marker=%s\n' "$install_marker"
