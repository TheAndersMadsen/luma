#!/usr/bin/bash
# Logging, failure, target/layout assertions, env-file editing, and
# copy-once primitives.
#
# Sourced by remote/common.sh; not an entry point. Functions here rely on
# the constants and siblings the loader defines before any of them runs.

log() { printf '[ai-pin-revival] %s\n' "$*"; }

warn() { printf '[ai-pin-revival] warning: %s\n' "$*" >&2; }

fail() { printf '[ai-pin-revival] error: %s\n' "$*" >&2; exit 1; }

usage_fail() { printf '[ai-pin-revival] error: %s\n' "$*" >&2; exit 64; }

need() { command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"; }

assert_target() {
  local actual_host actual_user actual_arch
  actual_host="$(hostname -s)"
  actual_user="$(id -un)"
  actual_arch="$(uname -m)"
  [[ "$actual_host" == "$EXPECTED_HOST" ]] || fail "refusing target host '$actual_host' (expected '$EXPECTED_HOST')"
  [[ "$actual_user" == "$EXPECTED_USER" ]] || fail "refusing target user '$actual_user' (expected '$EXPECTED_USER')"
  case "$EXPECTED_ARCH:$actual_arch" in
    aarch64:aarch64|arm64:aarch64|aarch64:arm64|arm64:arm64) ;;
    *) fail "refusing target architecture '$actual_arch' (expected '$EXPECTED_ARCH')" ;;
  esac
}

assert_remote_root() {
  [[ "$REMOTE_ROOT" == /home/anders/ai-pin-revival ]] || fail "unexpected remote root"
}

ensure_layout() {
  assert_remote_root
  [[ ! -L "$DATA_DIR" && ! -L "$PIN_RELEASE_DIR" ]] \
    || fail "canonical Pin release data path is a symlink"
  mkdir -p -- "$REMOTE_ROOT" "$PRIVATE_DIR" "$DATA_DIR" "$PIN_RELEASE_DIR" \
    "$BACKUP_ROOT" "$DEPLOYMENTS_DIR" "$PACKAGES_DIR" "$MANIFESTS_DIR" "$RELEASES_DIR"
  chmod 700 "$REMOTE_ROOT" "$PRIVATE_DIR" "$DATA_DIR" "$PIN_RELEASE_DIR" \
    "$BACKUP_ROOT" "$DEPLOYMENTS_DIR" "$PACKAGES_DIR" "$MANIFESTS_DIR" "$RELEASES_DIR"
  [[ "$(stat -c '%u' "$DATA_DIR")" == 1000 && "$(stat -c '%u' "$PIN_RELEASE_DIR")" == 1000 ]] \
    || fail "canonical Pin release data paths are not owned by the Center runtime uid"
  touch "$LOCK_FILE"
  chmod 600 "$LOCK_FILE"
}

read_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -v wanted="$key" '
    /^[[:space:]]*#/ { next }
    index($0, "=") == 0 { next }
    {
      name=substr($0,1,index($0,"=")-1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == wanted) value=substr($0,index($0,"=")+1)
    }
    END {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value ~ /^\042.*\042$/) value=substr(value,2,length(value)-2)
      if (length(value)) print value; else exit 1
    }
  ' "$file"
}

update_env_value() {
  local file="$1" key="$2" value="$3" temporary
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "invalid environment key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "environment value contains a newline"
  mkdir -p -- "$(dirname -- "$file")"
  [[ -e "$file" ]] || install -m 600 /dev/null "$file"
  temporary="$(mktemp "${file}.tmp.XXXXXX")"
  awk -v wanted="$key" -v replacement="$value" '
    BEGIN { changed=0 }
    {
      name=$0
      sub(/=.*/, "", name)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name == wanted) {
        if (!changed) print wanted "=" replacement
        changed=1
      } else print
    }
    END { if (!changed) print wanted "=" replacement }
  ' "$file" >"$temporary"
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$file"
}

remove_env_value() {
  local file="$1" key="$2" temporary
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && -f "$file" ]] || fail "invalid environment key removal"
  temporary="$(mktemp "${file}.tmp.XXXXXX")"
  awk -v unwanted="$key" '
    {
      name=$0; sub(/=.*/, "", name); gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != unwanted) print
    }
  ' "$file" >"$temporary"
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$file"
}

copy_file_once() {
  local source="$1" destination="$2"
  [[ -f "$destination" ]] && return 0
  [[ -f "$source" ]] || return 1
  install -m 600 "$source" "$destination"
}

copy_tree_once() {
  local source="$1" destination="$2"
  [[ -e "$destination" ]] && return 0
  [[ -d "$source" ]] || return 1
  mkdir -p -- "$(dirname -- "$destination")"
  cp -a -- "$source" "$destination"
}

json_result() {
  local status="$1" detail="$2"
  python3 - "$status" "$detail" <<'PY'
import json, sys
print(json.dumps({"ok": sys.argv[1] == "ok", "detail": sys.argv[2]}, separators=(",", ":")))
PY
}
