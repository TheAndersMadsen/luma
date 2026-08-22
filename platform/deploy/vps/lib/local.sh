#!/usr/bin/env -S /bin/bash -p
# Shared local-side helpers for the guarded anders-server deployment drivers.
# This file must never read or print production environment files.
set -euo pipefail

# Public VPS drivers source this library before doing any work.  If one was
# invoked directly, normalize it through the same fixed, positive environment
# used by ./revival.  Library-only unit fixtures source local.sh from `bash -c`;
# they are not public entry points and deliberately keep their injected test
# functions.
_revival_local_caller="${BASH_SOURCE[1]:-}"
case "${_revival_local_caller##*/}" in
  deploy.sh|backup.sh|canary.sh|drift.sh|adopt-config.sh|prune-state.sh|rollback.sh|preflight.sh)
    _revival_local_driver=1 ;;
  *) _revival_local_driver=0 ;;
esac

_revival_select_fixed() {
  local candidate
  for candidate in "$@"; do
    if [[ -x "$candidate" && ! -d "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

_revival_home="${HOME:-/nonexistent}"
[[ "$_revival_home" == /* ]] || _revival_home=/nonexistent
_revival_bash="$(_revival_select_fixed /opt/homebrew/bin/bash /usr/local/bin/bash /bin/bash /usr/bin/bash)" || exit 126
_revival_node="$(_revival_select_fixed /usr/bin/node /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node /opt/homebrew/bin/node /usr/local/bin/node)" || exit 126
_revival_python="$(_revival_select_fixed /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3)" || exit 126
_revival_git="$(_revival_select_fixed /usr/bin/git /opt/homebrew/bin/git /usr/local/bin/git)" || exit 126
_revival_ssh="$(_revival_select_fixed /usr/bin/ssh)" || exit 126
_revival_rsync="$(_revival_select_fixed /usr/bin/rsync /opt/homebrew/bin/rsync /usr/local/bin/rsync)" || exit 126
_revival_awk="$(_revival_select_fixed /usr/bin/awk)" || exit 126
_revival_tar="$(_revival_select_fixed /usr/bin/tar /bin/tar)" || exit 126
_revival_sha256sum="$(_revival_select_fixed /usr/bin/sha256sum /bin/sha256sum /opt/homebrew/bin/sha256sum /usr/local/bin/sha256sum || true)"
_revival_shasum="$(_revival_select_fixed /usr/bin/shasum || true)"
[[ -n "$_revival_sha256sum" || -n "$_revival_shasum" ]] || exit 126
_revival_path="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:$_revival_home/.cargo/bin:$_revival_home/Android/Sdk/platform-tools:$_revival_home/Library/Android/sdk/platform-tools"

# REVIVAL_LOCAL_AUTHORITY is intentionally not a capability: an environment
# variable can be forged.  It is only a loop marker, and is accepted when the
# complete positive command/environment authority exactly matches what this
# process would construct itself.  A forged marker with a hostile PATH must
# therefore take the sanitizing re-exec path before deploy.sh can run mktemp or
# any other external utility.
_revival_positive_authority=0
if ((_revival_local_driver)) \
  && [[ "${REVIVAL_LOCAL_AUTHORITY:-}" == v1 \
    && "${HOME:-}" == "$_revival_home" && "${PATH:-}" == "$_revival_path" \
    && "${LANG:-}" == C && "${LC_ALL:-}" == C && "${TZ:-}" == UTC \
    && "${REVIVAL_LOCAL_BASH:-}" == "$_revival_bash" \
    && "${REVIVAL_LOCAL_NODE:-}" == "$_revival_node" \
    && "${REVIVAL_LOCAL_PYTHON:-}" == "$_revival_python" \
    && "${REVIVAL_LOCAL_GIT:-}" == "$_revival_git" \
    && "${REVIVAL_LOCAL_SSH:-}" == "$_revival_ssh" \
    && "${REVIVAL_LOCAL_RSYNC:-}" == "$_revival_rsync" \
    && "${REVIVAL_LOCAL_AWK:-}" == "$_revival_awk" \
    && "${REVIVAL_LOCAL_TAR:-}" == "$_revival_tar" \
    && "${REVIVAL_LOCAL_SHA256SUM:-}" == "$_revival_sha256sum" \
    && "${REVIVAL_LOCAL_SHASUM:-}" == "$_revival_shasum" \
    && "${REVIVAL_SSH_IDENTITY_FILE:-}" == /* \
    && "${REVIVAL_SSH_KNOWN_HOSTS_FILE:-}" == /* ]]; then
  _revival_positive_authority=1
  for _revival_forbidden in BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME PYTHONSTARTUP DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG GIT_DIR GIT_WORK_TREE GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_SSH_COMMAND SSH_AUTH_SOCK RSYNC_RSH; do
    [[ -z "${!_revival_forbidden+x}" ]] || _revival_positive_authority=0
  done
fi

if ((_revival_local_driver)) && ((!_revival_positive_authority)); then
  _revival_identity="${REVIVAL_SSH_IDENTITY_FILE:-$_revival_home/.ssh/id_ed25519}"
  _revival_known_hosts="${REVIVAL_SSH_KNOWN_HOSTS_FILE:-$_revival_home/.ssh/known_hosts}"
  builtin exec /usr/bin/env -i HOME="$_revival_home" PATH="$_revival_path" LANG=C LC_ALL=C TZ=UTC \
    REVIVAL_LOCAL_AUTHORITY=v1 REVIVAL_LOCAL_BASH="$_revival_bash" REVIVAL_LOCAL_NODE="$_revival_node" \
    REVIVAL_LOCAL_PYTHON="$_revival_python" REVIVAL_LOCAL_GIT="$_revival_git" REVIVAL_LOCAL_SSH="$_revival_ssh" \
    REVIVAL_LOCAL_RSYNC="$_revival_rsync" REVIVAL_LOCAL_AWK="$_revival_awk" REVIVAL_LOCAL_TAR="$_revival_tar" \
    REVIVAL_LOCAL_SHA256SUM="$_revival_sha256sum" REVIVAL_LOCAL_SHASUM="$_revival_shasum" \
    REVIVAL_SSH_IDENTITY_FILE="$_revival_identity" REVIVAL_SSH_KNOWN_HOSTS_FILE="$_revival_known_hosts" \
    REVIVAL_CONFIG_DIR="${REVIVAL_CONFIG_DIR:-}" REVIVAL_SECRETS_DIR="${REVIVAL_SECRETS_DIR:-}" \
    REVIVAL_DATA_DIR="${REVIVAL_DATA_DIR:-}" REVIVAL_BACKUP_DIR="${REVIVAL_BACKUP_DIR:-}" \
    REVIVAL_ENV_FILE="${REVIVAL_ENV_FILE:-}" REVIVAL_PRIVATE_DIR="${REVIVAL_PRIVATE_DIR:-}" \
    REVIVAL_BUILD_DIR="${REVIVAL_BUILD_DIR:-}" REVIVAL_DEPLOY_REMOTE="${REVIVAL_DEPLOY_REMOTE:-}" \
    "$_revival_bash" --noprofile --norc "$0" "$@"
fi

if ((_revival_local_driver)); then
  [[ "${REVIVAL_LOCAL_AUTHORITY:-}" == v1 && "$_revival_positive_authority" == 1 ]] || { builtin printf 'error: unsupported unsanitized VPS driver invocation\n' >&2; exit 126; }
  for _revival_forbidden in BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME PYTHONSTARTUP DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG GIT_DIR GIT_WORK_TREE GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_SSH_COMMAND SSH_AUTH_SOCK RSYNC_RSH; do
    [[ -z "${!_revival_forbidden+x}" ]] || { builtin printf 'error: forbidden local startup environment: %s\n' "$_revival_forbidden" >&2; exit 126; }
  done
fi

VPS_LIB_DIR="$(builtin cd -- "${BASH_SOURCE[0]%/*}" && builtin pwd -P)"
VPS_DIR="$(builtin cd -- "$VPS_LIB_DIR/.." && builtin pwd -P)"
REVIVAL_ROOT="$(builtin cd -- "$VPS_DIR/../../.." && builtin pwd -P)"
REMOTE_IMPL="$VPS_DIR/remote"

DEPLOY_REMOTE="${REVIVAL_DEPLOY_REMOTE:-vps}"
REMOTE_ROOT="/home/anders/ai-pin-revival"
EXPECTED_HOST="anders-server"
EXPECTED_USER="anders"
EXPECTED_ARCH="aarch64"
REMOTE_POSITIVE_ENV="/usr/bin/env -i HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/bin:/usr/sbin TZ=UTC"
REMOTE_CLEAN_BASH="$REMOTE_POSITIVE_ENV /usr/bin/bash --noprofile --norc"
REMOTE_CLEAN_PYTHON="$REMOTE_POSITIVE_ENV /usr/bin/python3 -I -B"

RELEASE_VERIFIER_PATH="platform/deploy/vps/verify-release.py"
RELEASE_DEPLOY_DRIVER_PATH="platform/deploy/vps/remote/deploy.sh"
RELEASE_DEPLOY_COMMON_PATH="platform/deploy/vps/remote/common.sh"
RELEASE_PREFLIGHT_PATH="platform/deploy/vps/remote/preflight.sh"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage_error() {
  printf 'error: %s\n' "$*" >&2
  exit 64
}

need_local() {
  local candidate=""
  case "$1" in
    bash) candidate="${REVIVAL_LOCAL_BASH:-}" ;;
    node) candidate="${REVIVAL_LOCAL_NODE:-}" ;;
    python3) candidate="${REVIVAL_LOCAL_PYTHON:-}" ;;
    git) candidate="${REVIVAL_LOCAL_GIT:-}" ;;
    ssh) candidate="${REVIVAL_LOCAL_SSH:-}" ;;
    rsync) candidate="${REVIVAL_LOCAL_RSYNC:-}" ;;
    sha256sum) candidate="${REVIVAL_LOCAL_SHA256SUM:-}" ;;
    shasum) candidate="${REVIVAL_LOCAL_SHASUM:-}" ;;
    awk) candidate="${REVIVAL_LOCAL_AWK:-}" ;;
    tar) candidate="${REVIVAL_LOCAL_TAR:-}" ;;
    *) die "unsupported local command authority request: $1" ;;
  esac
  case "$1:$candidate" in
    bash:/bin/bash|bash:/usr/bin/bash|bash:/opt/homebrew/bin/bash|bash:/usr/local/bin/bash|\
    node:/usr/bin/node|node:/usr/local/bin/node|node:/opt/homebrew/opt/node@22/bin/node|node:/usr/local/opt/node@22/bin/node|node:/opt/homebrew/bin/node|\
    python3:/usr/bin/python3|python3:/usr/local/bin/python3|python3:/opt/homebrew/bin/python3|\
    git:/usr/bin/git|git:/usr/local/bin/git|git:/opt/homebrew/bin/git|\
    ssh:/usr/bin/ssh|\
    rsync:/usr/bin/rsync|rsync:/usr/local/bin/rsync|rsync:/opt/homebrew/bin/rsync|\
    sha256sum:/usr/bin/sha256sum|sha256sum:/bin/sha256sum|sha256sum:/usr/local/bin/sha256sum|sha256sum:/opt/homebrew/bin/sha256sum|\
    shasum:/usr/bin/shasum|awk:/usr/bin/awk|tar:/usr/bin/tar|tar:/bin/tar) ;;
    *) die "local command is outside the supported fixed-path authority: $1" ;;
  esac
  [[ "$candidate" == /* && -x "$candidate" && ! -d "$candidate" ]] \
    || die "required local command is unavailable at its fixed path: $1"
}

require_safe_remote_name() {
  [[ "$DEPLOY_REMOTE" =~ ^[A-Za-z0-9._@:-]+$ ]] || usage_error "unsafe SSH target"
}

run_ssh() {
  require_safe_remote_name
  require_ssh_authority
  "${REVIVAL_LOCAL_SSH:?}" \
    -F /dev/null \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=2 \
    -o GlobalKnownHostsFile=/dev/null \
    -o "UserKnownHostsFile=$REVIVAL_SSH_KNOWN_HOSTS_FILE" \
    -o StrictHostKeyChecking=yes \
    -o CheckHostIP=yes \
    -o IdentitiesOnly=yes \
    -o IdentityAgent=none \
    -o "IdentityFile=$REVIVAL_SSH_IDENTITY_FILE" \
    "$DEPLOY_REMOTE" "$@"
}

run_local_node() {
  if ((_revival_local_driver)); then "${REVIVAL_LOCAL_NODE:?}" "$@"; else node "$@"; fi
}

run_local_python() {
  if ((_revival_local_driver)); then "${REVIVAL_LOCAL_PYTHON:?}" "$@"; else python3 "$@"; fi
}

run_local_rsync() {
  if ((_revival_local_driver)); then "${REVIVAL_LOCAL_RSYNC:?}" "$@"; else rsync "$@"; fi
}

require_ssh_authority() {
  need_local ssh
  [[ "$REVIVAL_SSH_IDENTITY_FILE" == /* && "$REVIVAL_SSH_KNOWN_HOSTS_FILE" == /* ]] \
    || die "SSH identity and known-host authority must be absolute paths"
  "${REVIVAL_LOCAL_PYTHON:?}" -I -B - "$REVIVAL_SSH_IDENTITY_FILE" "$REVIVAL_SSH_KNOWN_HOSTS_FILE" <<'PY' \
    || die "SSH identity or known-host authority is unsafe"
import os,stat,sys
for index,name in enumerate(sys.argv[1:]):
    value=os.lstat(name)
    assert stat.S_ISREG(value.st_mode) and value.st_uid==os.getuid() and value.st_nlink==1
    assert stat.S_IMODE(value.st_mode) in ((0o600,) if index==0 else (0o600,0o644))
PY
}

rsync_remote_shell() {
  if ((!_revival_local_driver)); then
    printf '%s' /usr/bin/ssh
    return 0
  fi
  require_ssh_authority
  local pieces=(
    "$REVIVAL_LOCAL_SSH" -F /dev/null
    -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2
    -o GlobalKnownHostsFile=/dev/null -o "UserKnownHostsFile=$REVIVAL_SSH_KNOWN_HOSTS_FILE"
    -o StrictHostKeyChecking=yes -o CheckHostIP=yes -o IdentitiesOnly=yes -o IdentityAgent=none
    -o "IdentityFile=$REVIVAL_SSH_IDENTITY_FILE"
  ) item rendered=""
  for item in "${pieces[@]}"; do
    printf -v item '%q' "$item"
    rendered+="${rendered:+ }$item"
  done
  printf '%s' "$rendered"
}

UPLOAD_LEASE_PID=""
UPLOAD_LEASE_READ_FD=""
UPLOAD_LEASE_WRITE_FD=""

start_remote_upload_lease() {
  [[ -z "$UPLOAD_LEASE_PID" ]] || die "remote upload lease is already active"
  require_safe_remote_name
  local lease_code lease_args ready
  lease_code='import fcntl,os,stat,sys
root=sys.argv[1]
assert root=="/home/anders/ai-pin-revival"
def open_absolute(path):
    descriptor=os.open("/",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            assert component and component not in (".","..")
            child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
            os.close(descriptor); descriptor=child
        return descriptor
    except BaseException:
        os.close(descriptor); raise
root_fd=open_absolute(root)
try:
    lock=os.open("upload.lock",os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=root_fd)
    metadata=os.fstat(lock)
    assert stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==1
    assert (metadata.st_uid,metadata.st_gid,stat.S_IMODE(metadata.st_mode))==(os.getuid(),os.getgid(),0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    os.fsync(lock); os.fsync(root_fd)
    print("READY",flush=True)
    sys.stdin.buffer.read()
finally:
    try: os.close(lock)
    except (NameError,OSError): pass
    os.close(root_fd)'
  lease_args="$(remote_quote "$lease_code" "$REMOTE_ROOT")"
  coproc REVIVAL_UPLOAD_LEASE_PROCESS { run_ssh "$REMOTE_CLEAN_PYTHON -c $lease_args"; }
  UPLOAD_LEASE_PID="$REVIVAL_UPLOAD_LEASE_PROCESS_PID"
  UPLOAD_LEASE_READ_FD="${REVIVAL_UPLOAD_LEASE_PROCESS[0]}"
  UPLOAD_LEASE_WRITE_FD="${REVIVAL_UPLOAD_LEASE_PROCESS[1]}"
  if ! IFS= read -r -t 15 ready <&"$UPLOAD_LEASE_READ_FD" || [[ "$ready" != READY ]]; then
    stop_remote_upload_lease 1 || true
    die "remote upload lease could not be acquired"
  fi
}

assert_remote_upload_lease() {
  [[ "$UPLOAD_LEASE_PID" =~ ^[0-9]+$ && "$UPLOAD_LEASE_WRITE_FD" =~ ^[0-9]+$ ]] \
    || die "remote upload lease is not active"
  kill -0 "$UPLOAD_LEASE_PID" 2>/dev/null \
    || die "remote upload lease was lost before deployment handoff"
}

stop_remote_upload_lease() {
  local tolerate_failure="${1:-0}" status=0
  if [[ "$UPLOAD_LEASE_WRITE_FD" =~ ^[0-9]+$ ]]; then
    exec {UPLOAD_LEASE_WRITE_FD}>&- || status=1
  fi
  if [[ "$UPLOAD_LEASE_READ_FD" =~ ^[0-9]+$ ]]; then
    exec {UPLOAD_LEASE_READ_FD}<&- || status=1
  fi
  if [[ "$UPLOAD_LEASE_PID" =~ ^[0-9]+$ ]]; then
    wait "$UPLOAD_LEASE_PID" || status=1
  fi
  UPLOAD_LEASE_PID=""; UPLOAD_LEASE_READ_FD=""; UPLOAD_LEASE_WRITE_FD=""
  ((status == 0 || tolerate_failure != 0))
}

remote_quote() {
  local quoted=() value
  for value in "$@"; do
    printf -v value '%q' "$value"
    quoted+=("$value")
  done
  printf '%s ' "${quoted[@]}"
}

validate_remote_root() {
  local candidate="$1"
  [[ "$candidate" =~ ^/[A-Za-z0-9._/-]+$ ]] || usage_error "unsafe remote root"
  [[ "$candidate" != *"//"* && "$candidate" != */./* && "$candidate" != */../* && "$candidate" != */. && "$candidate" != */.. ]] \
    || usage_error "unsafe remote root"
}

# Shell emitted into the streamed bootstrap immediately before the entry point
# is exec'd, and empty for every caller that does not deliberately set it. It
# exists because run_remote_impl streams a script that is NOT part of any
# release, so the target-identity and mutual-exclusion guarantees that
# run_current_release_operation gets from its own bootstrap have to be restated
# by whoever wants them. preflight.sh and adopt-config.sh leave it empty and are
# byte-for-byte unaffected.
REMOTE_IMPL_GUARD=""

# Run a remote implementation by concatenating the reviewed, secret-free common
# library and one entry point over stdin. No helper is installed on the target
# merely to perform a read-only preflight or drift check.
run_remote_impl() {
  local implementation="$1"
  shift
  [[ -f "$REMOTE_IMPL/$implementation" ]] || die "missing remote implementation: $implementation"
  local args
  args="$(remote_quote "$@")"
 {
    cat <<'BOOTSTRAP'
set -euo pipefail
tmp_dir="$(mktemp -d)"
cleanup_remote_impl() {
  rm -rf -- "$tmp_dir"
}
trap cleanup_remote_impl EXIT
cat <<'__REVIVAL_COMMON__' > "$tmp_dir/common.sh"
BOOTSTRAP
    cat "$REMOTE_IMPL/common.sh"
    cat <<'BOOTSTRAP'
__REVIVAL_COMMON__
mkdir -p "$tmp_dir/lib"
BOOTSTRAP
    local common_lib
    for common_lib in "$REMOTE_IMPL"/lib/*.sh; do
      printf 'cat <<'"'"'__REVIVAL_COMMON_LIB__'"'"' > "$tmp_dir/lib/%s"\n' "$(basename "$common_lib")"
      cat "$common_lib"
      printf '__REVIVAL_COMMON_LIB__\nchmod 600 "$tmp_dir/lib/%s"\n' "$(basename "$common_lib")"
    done
    cat <<'BOOTSTRAP'
cat <<'__REVIVAL_DOMAIN__' > "$tmp_dir/domain.sh"
BOOTSTRAP
    cat "$REMOTE_IMPL/domain.sh"
    cat <<'BOOTSTRAP'
__REVIVAL_DOMAIN__
cat <<'__REVIVAL_DOMAIN_PY__' > "$tmp_dir/domain.py"
BOOTSTRAP
    cat "$REMOTE_IMPL/domain.py"
    cat <<'BOOTSTRAP'
__REVIVAL_DOMAIN_PY__
cat <<'__REVIVAL_TRANSACTION__' > "$tmp_dir/transaction.py"
BOOTSTRAP
    cat "$REMOTE_IMPL/transaction.py"
    cat <<'BOOTSTRAP'
__REVIVAL_TRANSACTION__
cat <<'__REVIVAL_ADOPT_CONFIG__' > "$tmp_dir/adopt-config.py"
BOOTSTRAP
    cat "$REMOTE_IMPL/adopt-config.py"
    cat <<'BOOTSTRAP'
__REVIVAL_ADOPT_CONFIG__
cat <<'__REVIVAL_PRUNE_STATE__' > "$tmp_dir/prune-state.py"
BOOTSTRAP
    cat "$REMOTE_IMPL/prune-state.py"
    cat <<'BOOTSTRAP'
__REVIVAL_PRUNE_STATE__
cat <<'__REVIVAL_RETENTION_STORE__' > "$tmp_dir/retention-store.py"
BOOTSTRAP
    cat "$REMOTE_IMPL/retention-store.py"
    cat <<'BOOTSTRAP'
__REVIVAL_RETENTION_STORE__
BOOTSTRAP
    printf 'cat <<'"'"'__REVIVAL_ENTRYPOINT__'"'"' > "$tmp_dir/%s"\n' "$implementation"
    cat "$REMOTE_IMPL/$implementation"
    cat <<'BOOTSTRAP'
__REVIVAL_ENTRYPOINT__
chmod 600 "$tmp_dir/common.sh" "$tmp_dir/domain.sh" "$tmp_dir/domain.py" "$tmp_dir/transaction.py" \
  "$tmp_dir/adopt-config.py" "$tmp_dir/prune-state.py" "$tmp_dir/retention-store.py"
BOOTSTRAP
    printf 'chmod 700 "$tmp_dir/%s"\n' "$implementation"
    printf '%s\n' "$REMOTE_IMPL_GUARD"
    # NOT `exec`. exec replaces this shell, so the EXIT trap installed above never
    # runs and every streamed operation leaves its staging directory behind.
    #
    # SIZED HONESTLY, because the first version of this comment was not and the
    # number mattered. Measured on the host on 2026-08-12: the leaked directories
    # hold common.sh + domain.sh + domain.py + the entry point at 216 KiB each,
    # and ALL of /tmp/tmp.* together came to 900 KiB. /tmp is its own 4 GiB
    # tmpfs; the 2.8 GiB sitting in it is /tmp/cosmos-enroll-target (2.4 GiB) and
    # some unpacked tarballs, none of it written by this function. And it cannot
    # reach preflight's free-space refusal at all: preflight.sh:288 measures
    # `df -Pk /home/anders`, which is /dev/sda1, not this tmpfs.
    #
    # So this is a slow leak on a small filesystem, not a deploy-stopper: the end
    # state is a full tmpfs and an operation that cannot mktemp -d. Worth fixing
    # because leaving reviewed source on the host after a read-only check is
    # exactly what streaming instead of installing exists to avoid, not because
    # of the disk-growth problem `prune-state` was written for -- that one is on
    # /dev/sda1 and has nothing to do with this path.
    #
    # Scope, since only three commands reach here: preflight, adopt-config and
    # prune-state. `drift` and `canary` go through run_current_release_operation,
    # which execs out of the release tree on the host and stages nothing.
    #
    # Running it as a child keeps the trap, and the status is propagated by hand so
    # the caller sees exactly what the implementation returned. `set -e` must not
    # abort before the trap can clean up, hence the `|| status=$?`.
    printf 'status=0\n'
    printf '/usr/bin/bash --noprofile --norc "$tmp_dir/%s" "$@" || status=$?\n' "$implementation"
    printf 'exit "$status"\n'
  } | run_ssh "$REMOTE_CLEAN_BASH -s -- $args"
}

# ---------------------------------------------------------------------------
# THE WORKING-TREE CANARY, AND WHY IT IS A SUPPORTED FLAG RATHER THAN A ONE-OFF.
#
# `./revival canary` dispatches through run_current_release_operation, which
# runs the DEPLOYED release's canary.sh. That is the right default: an accepted
# deployment must be judged by the gate it was accepted under, and the deployed
# copy is the one bound to the release manifest.
#
# The cost is that a CHANGED canary.sh has no way to execute before a deploy
# depends on it. Its first ever run is then inside the cutover window, with
# public ingress already quiesced — so a typo in a new assertion does not fail a
# canary, it extends an outage. That is precisely backwards: the gate is the one
# script that most needs to have been run before it matters.
#
# So: stream the working tree's canary.sh and run it against production the same
# way preflight.sh is already run, and restate the two properties the release
# bootstrap would otherwise have supplied.
#
#   * TARGET IDENTITY. Same host, user and architecture assertions as
#     run_current_release_operation. canary.sh calls assert_target itself, but
#     that is the streamed tree's copy asserting on its own behalf; the check
#     belongs here too, where it does not depend on the script under test.
#   * THE DEPLOY LOCK. Held for the whole run, non-blocking, exactly as the
#     stateful-operation bootstrap holds it. A canary that observed a stack
#     mid-cutover would report a fault that is not one, and — the direction that
#     actually matters on a live host — a canary must never be the thing that
#     runs beside a deploy.
#
# WHAT THIS DELIBERATELY DOES NOT DO. It does not verify a release, because
# there is no release to verify: the whole point is code that has not been cut
# yet. That is the entire difference from the default path, it is why the flag
# is named --from-tree, and it is why no automation may use it. Nothing in
# deploy.sh or rollback.sh reaches this function; canary-wearer-plane.test.mjs
# fails if that changes.
run_working_tree_canary() {
  [[ -f "$REMOTE_IMPL/canary.sh" ]] || die "missing remote implementation: canary.sh"
  REMOTE_IMPL_GUARD='
root=/home/anders/ai-pin-revival
[[ "$(hostname -s)" == anders-server && "$(id -un)" == anders ]] || { echo "working-tree canary target identity mismatch" >&2; exit 1; }
case "$(uname -m)" in aarch64|arm64) ;; *) echo "working-tree canary architecture mismatch" >&2; exit 1;; esac
[[ -d "$root" && ! -L "$root" ]] || { echo "working-tree canary remote root is not a directory" >&2; exit 1; }
exec 9>"$root/deploy.lock"
flock -n 9 || { echo "stateful operation lock is held" >&2; exit 1; }
'
  run_remote_impl canary.sh "$@"
}

# Confirm that the selected manifest contains the complete, release-bound
# bootstrap contract. The deploy implementation is later executed only from the
# tree atomically extracted by that release's own verifier.
assert_release_bootstrap_contract() {
  local manifest="$1" expected_release_id="$2"
  run_local_node - "$manifest" "$expected_release_id" \
    "$RELEASE_VERIFIER_PATH" "$RELEASE_DEPLOY_DRIVER_PATH" "$RELEASE_DEPLOY_COMMON_PATH" \
    "$RELEASE_PREFLIGHT_PATH" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [manifestPath, expectedReleaseId, ...requiredPaths] = process.argv.slice(2);
const metadata = fs.lstatSync(manifestPath);
if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('release manifest must be a regular file');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const payload = JSON.stringify({
  schemaVersion: manifest.schemaVersion,
  profile: manifest.profile,
  entries: manifest.entries,
});
const calculated = crypto.createHash('sha256').update(payload).digest('hex');
if (manifest.profile !== 'vps' || manifest.releaseId !== expectedReleaseId || calculated !== expectedReleaseId) {
  throw new Error('selected manifest does not match the requested vps release');
}
const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
for (const requiredPath of requiredPaths) {
  const entry = entries.get(requiredPath);
  if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size)) {
    throw new Error(`selected release lacks a valid bootstrap entry: ${requiredPath}`);
  }
}
NODE
}

# Materialize one file from the already verified archive, and independently
# bind its bytes to the selected manifest. This is used to upload the selected
# release's verifier rather than the mutable workspace copy.
materialize_release_member() {
  local archive manifest expected_release_id member destination
  case "$#" in
    4)
      archive="$1"; manifest="$2"; expected_release_id=""; member="$3"; destination="$4"
      ;;
    5)
      archive="$1"; manifest="$2"; expected_release_id="$3"; member="$4"; destination="$5"
      ;;
    *) usage_error "materialize_release_member expects archive, manifest, optional release id, member, and destination" ;;
  esac
  run_local_node - "$archive" "$manifest" "$expected_release_id" "$member" "$destination" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');
const [archivePath, manifestPath, expectedReleaseId, wantedPath, destination] = process.argv.slice(2);
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
for (const [path, label] of [[archivePath, 'archive'], [manifestPath, 'manifest']]) {
  const metadata = fs.lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (label === 'archive' && metadata.size > MAX_ARCHIVE_BYTES) throw new Error('archive exceeds size limit');
}
const outputMetadata = fs.lstatSync(destination);
if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink() || outputMetadata.size !== 0) {
  throw new Error('materialization target must be a new empty regular file');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const payload = JSON.stringify({schemaVersion:manifest.schemaVersion,profile:manifest.profile,entries:manifest.entries});
const releaseId = crypto.createHash('sha256').update(payload).digest('hex');
const selectedReleaseId = expectedReleaseId || manifest.releaseId;
if (manifest.profile !== 'vps' || manifest.releaseId !== selectedReleaseId || releaseId !== selectedReleaseId) {
  throw new Error('manifest identity does not match expected release before materialization');
}
const entry = manifest.entries?.find((candidate) => candidate.path === wantedPath);
if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256) || !/^(?:0644|0755)$/.test(entry.mode)) {
  throw new Error('selected release member is absent or invalid');
}
const compressed = fs.readFileSync(archivePath);
const tar = zlib.gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES });
const readString = (buffer, offset, length) => {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
};
const readOctal = (buffer, offset, length) => {
  const raw = buffer.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error('invalid tar numeric field');
  return Number.parseInt(raw, 8);
};
let offset = 0;
let found;
const seen = new Set();
while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512);
  offset += 512;
  if (header.every((byte) => byte === 0)) break;
  const type = String.fromCharCode(header[156]);
  if (type !== '0' && type !== '\0') throw new Error('release archive contains a non-regular member');
  const name = readString(header, 0, 100);
  const prefix = readString(header, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  if (seen.has(path)) throw new Error('release archive contains a duplicate member');
  seen.add(path);
  const size = readOctal(header, 124, 12);
  const mode = readOctal(header, 100, 8).toString(8).padStart(4, '0');
  if (offset + size > tar.length) throw new Error('release archive is truncated');
  const data = tar.subarray(offset, offset + size);
  offset += size + ((512 - (size % 512)) % 512);
  if (path === wantedPath) found = { data: Buffer.from(data), mode };
}
if (!found || found.data.length !== entry.size || found.mode !== entry.mode) {
  throw new Error('selected release member does not match manifest metadata');
}
const digest = crypto.createHash('sha256').update(found.data).digest('hex');
if (digest !== entry.sha256) throw new Error('selected release member digest mismatch');
fs.writeFileSync(destination, found.data, { flag: 'w', mode: Number.parseInt(entry.mode, 8) });
fs.chmodSync(destination, Number.parseInt(entry.mode, 8));
NODE
}

snapshot_regular_file() {
  local source="$1" destination="$2"
  run_local_node - "$source" "$destination" <<'NODE'
const fs=require('node:fs');
const [source,destination]=process.argv.slice(2);
const before=fs.lstatSync(source,{bigint:true});
if (!before.isFile() || before.isSymbolicLink()) throw new Error('snapshot source must be a regular non-symlink file');
const input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
const opened=fs.fstatSync(input,{bigint:true});
for (const key of ['dev','ino','size','mtimeNs','ctimeNs']) if (opened[key]!==before[key]) throw new Error('snapshot source changed before open');
const output=fs.openSync(destination,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
try {
  const buffer=Buffer.allocUnsafe(1024*1024); let position=0;
  for (;;) { const count=fs.readSync(input,buffer,0,buffer.length,position); if (!count) break; fs.writeSync(output,buffer,0,count); position+=count; }
  fs.fsyncSync(output);
} finally { fs.closeSync(output); fs.closeSync(input); }
const after=fs.lstatSync(source,{bigint:true});
for (const key of ['dev','ino','size','mtimeNs','ctimeNs']) if (after[key]!==before[key]) { fs.rmSync(destination,{force:true}); throw new Error('snapshot source changed while being copied'); }
NODE
}

remote_preupload_gate() {
  local release_id="$1" min_free_gb="$2" archive_bytes="$3" incoming="$4" args
  validate_release_id "$release_id"
  [[ "$min_free_gb" =~ ^[0-9]+$ && "$archive_bytes" =~ ^[0-9]+$ ]] || usage_error "invalid capacity gate"
  args="$(remote_quote "$EXPECTED_HOST" "$EXPECTED_USER" "$EXPECTED_ARCH" "$REMOTE_ROOT" \
    "$release_id" "$min_free_gb" "$archive_bytes" "$incoming")"
  run_ssh "$REMOTE_CLEAN_BASH -s -- $args" <<'REMOTE'
set -euo pipefail
host="$1"; user="$2"; arch="$3"; root="$4"; release_id="$5"; min_gb="$6"; archive_bytes="$7"; incoming="$8"
[[ "$(hostname -s)" == "$host" && "$(id -un)" == "$user" ]] || { echo 'pre-upload target identity mismatch' >&2; exit 1; }
case "$arch:$(uname -m)" in aarch64:aarch64|aarch64:arm64) ;; *) echo 'pre-upload architecture mismatch' >&2; exit 1;; esac
[[ "$root" == /home/anders/ai-pin-revival && "$incoming" == "$root/incoming/$release_id" ]] || exit 1
if [[ -e "$root" || -L "$root" ]]; then [[ -d "$root" && ! -L "$root" ]] || exit 1; fi
[[ ! -e "$incoming" && ! -L "$incoming" ]] || { echo 'incoming release path already exists' >&2; exit 1; }
available_kb="$(df -Pk /home/anders | awk 'NR==2 {print $4}')"
required_kb=$((min_gb * 1024 * 1024 + archive_bytes * 6 / 1024))
((available_kb >= required_kb)) || { echo 'insufficient remote build capacity' >&2; exit 1; }
lock="$root/deploy.lock"
if [[ -e "$lock" || -L "$lock" ]]; then
  [[ -f "$lock" && ! -L "$lock" ]] || exit 1
  flock -n "$lock" -c true || { echo 'deployment lock is held' >&2; exit 1; }
fi
REMOTE
}

# The stdin body is deliberately only a bootstrap: it validates guarded paths,
# asks the selected release's verifier to atomically extract a new driver tree,
# verifies that tree again, then execs the selected release's deploy entry point.
run_verified_release_deploy() {
  local release_id="$1" incoming="$2" archive="$3" manifest="$4" verifier="$5" deployment_id="$6"
  local min_free_gb="$7" archive_bytes="$8" cleanup="$9" json="${10}" skip_smoke="${11:-0}"
  local candidate_id="${12:-}" candidate_root="${13:-}" deployment_authority_sha256="${14:-}"
  validate_release_id "$release_id"
  validate_remote_root "$REMOTE_ROOT"
  [[ "$min_free_gb" =~ ^[0-9]+$ && "$archive_bytes" =~ ^[0-9]+$ && "$cleanup" =~ ^[01]$ \
     && "$json" =~ ^[01]$ && "$skip_smoke" =~ ^[01]$ && "$candidate_id" =~ ^[0-9a-f]{64}$ \
     && "$candidate_root" == "$incoming/.candidate-$candidate_id.partial/$candidate_id" \
     && "$deployment_authority_sha256" =~ ^[0-9a-f]{64}$ ]] \
    || usage_error "invalid selected-release deployment arguments"
  local args
  args="$(remote_quote \
    "$release_id" "$REMOTE_ROOT" "$incoming" "$archive" "$manifest" "$verifier" \
    "$deployment_id" "$min_free_gb" "$archive_bytes" "$cleanup" "$json" \
    "$EXPECTED_HOST" "$EXPECTED_USER" "$EXPECTED_ARCH" "$skip_smoke" "$candidate_id" "$candidate_root" \
    "$deployment_authority_sha256")"
  {
    cat <<'BOOTSTRAP'
set -euo pipefail
umask 077
release_id="$1"; remote_root="$2"; incoming="$3"; archive="$4"; manifest="$5"; verifier="$6"
deployment_id="$7"; min_free_gb="$8"; archive_bytes="$9"; cleanup="${10}"; emit_json="${11}"
expected_host="${12}"; expected_user="${13}"; expected_arch="${14}"; skip_smoke="${15:-0}"
candidate_id="${16}"; candidate_root="${17}"; deployment_authority_sha256="${18}"
[[ "$release_id" =~ ^[0-9a-f]{64}$ ]] || { echo 'release bootstrap failed: invalid release id' >&2; exit 1; }
[[ "$incoming" == "$remote_root/incoming/$release_id" ]] || { echo 'release bootstrap failed: invalid incoming directory' >&2; exit 1; }
[[ "$candidate_id" =~ ^[0-9a-f]{64}$ \
   && "$candidate_root" == "$incoming/.candidate-$candidate_id.partial/$candidate_id" \
   && "$deployment_authority_sha256" =~ ^[0-9a-f]{64}$ \
   && -d "$candidate_root" && ! -L "$candidate_root" ]] \
  || { echo 'release bootstrap failed: invalid immutable candidate root' >&2; exit 1; }
transport_root="$(dirname -- "$candidate_root")"
transport="$transport_root/transport.sha256"
deployment_authority="$transport_root/deployment-authority.json"
[[ -f "$transport" && ! -L "$transport" \
   && "$(stat -c '%a:%u:%g:%h' "$transport")" == "600:$(id -u):$(id -g):1" \
   && "$(sha256sum "$transport" | awk '{print $1}')" =~ ^[0-9a-f]{64}$ ]] \
  || { echo 'release bootstrap failed: invalid candidate transport receipt' >&2; exit 1; }
[[ -f "$deployment_authority" && ! -L "$deployment_authority" \
   && "$(stat -c '%a:%u:%g:%h' "$deployment_authority")" == "600:$(id -u):$(id -g):1" \
   && "$(sha256sum "$deployment_authority" | awk '{print $1}')" == "$deployment_authority_sha256" ]] \
  || { echo 'release bootstrap failed: hosted deployment authority changed' >&2; exit 1; }
(cd "$transport_root" && sha256sum -c transport.sha256 >/dev/null) \
  || { echo 'release bootstrap failed: candidate hash ACK failed' >&2; exit 1; }
/usr/bin/python3 -I -B - "$remote_root" "$incoming" "$transport_root" "$candidate_root" "$release_id" "$candidate_id" \
  "$deployment_authority_sha256" <<'PY' \
  || { echo 'release bootstrap failed: candidate ancestry or metadata is unsafe' >&2; exit 1; }
import ctypes,hashlib,json,os,re,secrets,stat,sys
root,incoming,transport,candidate,release_id,candidate_id,authority_sha256=sys.argv[1:]
uid=os.getuid(); gid=os.getgid()
assert os.path.isabs(root) and os.path.normpath(root)==root
assert incoming==f"{root}/incoming/{release_id}"
assert transport==f"{incoming}/.candidate-{candidate_id}.partial"
assert candidate==f"{transport}/{candidate_id}"
expected={"candidate.json","compose-model.json","image-receipt.json","images.tar","production-state.json","release.json",
          "release.manifest.json","release.tar.gz","source-commit.txt","source-receipt.json",
          "source-snapshot.tar","toolchain-receipt.json","verify-release.py"}
def open_absolute(path):
    descriptor=os.open("/",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for component in path.split("/")[1:]:
            assert component and component not in (".","..")
            child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
            os.close(descriptor); descriptor=child
        return descriptor
    except BaseException:
        os.close(descriptor); raise
def open_child(parent,name):
    before=os.stat(name,dir_fd=parent,follow_symlinks=False)
    descriptor=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    opened=os.fstat(descriptor)
    assert stat.S_ISDIR(opened.st_mode)
    assert (opened.st_dev,opened.st_ino)==(before.st_dev,before.st_ino)
    assert (opened.st_uid,opened.st_gid,stat.S_IMODE(opened.st_mode))==(uid,gid,0o700)
    return descriptor
root_fd=open_absolute(root)
descriptors=[root_fd]
try:
    root_meta=os.fstat(root_fd)
    assert (root_meta.st_uid,root_meta.st_gid,stat.S_IMODE(root_meta.st_mode))==(uid,gid,0o700)
    incoming_parent=open_child(root_fd,"incoming"); descriptors.append(incoming_parent)
    incoming_fd=open_child(incoming_parent,release_id); descriptors.append(incoming_fd)
    transport_fd=open_child(incoming_fd,f".candidate-{candidate_id}.partial"); descriptors.append(transport_fd)
    candidate_fd=open_child(transport_fd,candidate_id); descriptors.append(candidate_fd)
    assert set(os.listdir(transport_fd))=={candidate_id,"deployment-authority.json","transport.sha256"}
    assert set(os.listdir(candidate_fd))==expected
    for directory,names in ((transport_fd,{"deployment-authority.json","transport.sha256"}),(candidate_fd,expected)):
        for name in names:
            metadata=os.stat(name,dir_fd=directory,follow_symlinks=False)
            assert stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
            assert (metadata.st_uid,metadata.st_gid,stat.S_IMODE(metadata.st_mode),metadata.st_nlink)==(uid,gid,0o600,1)
            file_descriptor=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
            opened=os.fstat(file_descriptor); os.close(file_descriptor)
            assert (opened.st_dev,opened.st_ino,opened.st_size)==(metadata.st_dev,metadata.st_ino,metadata.st_size)
    authority_fd=os.open("deployment-authority.json",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=transport_fd)
    try:
        authority_meta=os.fstat(authority_fd)
        authority=os.read(authority_fd,1024*1024+1)
        assert 0<len(authority)<=1024*1024 and hashlib.sha256(authority).hexdigest()==authority_sha256
        value=json.loads(authority)
        canonical=json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()+b"\n"
        fields={"schema","version","ok","candidateId","releaseId","sourceDigest","sourceTree","sourceArchiveSha256",
                "repository","sourceRef","runnerInvocationUri","candidateRoot","evidenceRoot","inventorySha256",
                "receiptSha256","providerBundleSha256","verificationSha256","evidenceSha256","manifestSha256","providerEvidence"}
        sha=re.compile(r"[0-9a-f]{64}"); git=re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")
        assert authority==canonical and set(value)==fields
        assert value["schema"]=="revival.hosted-vps-candidate-authority" and value["version"]==1 and value["ok"] is True
        assert value["candidateId"]==candidate_id and value["releaseId"]==release_id
        assert git.fullmatch(value["sourceDigest"]) and git.fullmatch(value["sourceTree"])
        for name in ("sourceArchiveSha256","inventorySha256","receiptSha256","providerBundleSha256",
                     "verificationSha256","evidenceSha256","manifestSha256"):
            assert sha.fullmatch(value[name])
        assert value["repository"]=="TheAndersMadsen/ai-pin-revival" and value["sourceRef"]=="refs/heads/main"
        assert re.fullmatch(r"https://github\.com/TheAndersMadsen/ai-pin-revival/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*",value["runnerInvocationUri"])
        assert value["providerEvidence"]=="point-of-use-reverified"
        assert os.path.isabs(value["candidateRoot"]) and os.path.isabs(value["evidenceRoot"])
        assert os.fstat(authority_fd)==authority_meta
    finally:
        os.close(authority_fd)
finally:
    for descriptor in reversed(descriptors): os.close(descriptor)
PY
for path in "$archive" "$manifest" "$verifier"; do
  [[ "$path" == "$candidate_root/"* && -f "$path" && ! -L "$path" ]] \
    || { echo 'release bootstrap failed: invalid input path' >&2; exit 1; }
done
driver_root="$incoming/verified-driver"
verification="$incoming/bootstrap-verification.json"
/usr/bin/python3 -I -B - --candidate "$candidate_root" --candidate-id "$candidate_id" \
  --release-id "$release_id" --driver-root "$driver_root" >"$verification" <<'__REVIVAL_BOOTSTRAP_RELEASE__'
BOOTSTRAP
    cat "$REMOTE_IMPL/bootstrap-release.py"
    cat <<'BOOTSTRAP'
__REVIVAL_BOOTSTRAP_RELEASE__
driver="$driver_root/platform/deploy/vps/remote/deploy.sh"
common="$driver_root/platform/deploy/vps/remote/common.sh"
preflight="$driver_root/platform/deploy/vps/remote/preflight.sh"
candidate_verifier="$driver_root/platform/deploy/release-candidate.mjs"
held_release_exec="$driver_root/platform/deploy/vps/remote/held-release-exec.py"
[[ -f "$driver" && ! -L "$driver" && -f "$common" && ! -L "$common" && \
   -f "$preflight" && ! -L "$preflight" \
   && -f "$candidate_verifier" && ! -L "$candidate_verifier" \
   && -f "$held_release_exec" && ! -L "$held_release_exec" ]] \
  || { echo 'release bootstrap failed: verified driver is incomplete' >&2; exit 1; }
run_held_bootstrap_entry() {
  local entry="$1" interpreter="$2"
  shift 2
  /usr/bin/python3 -I -B - "$held_release_exec" "$driver_root" "$manifest" "$release_id" "$entry" "$interpreter" "$@" <<'PY'
import fcntl,hashlib,json,os,stat,subprocess,sys
helper_path,tree,manifest,release_id,entry,interpreter,*arguments=sys.argv[1:]
def identity(value):
    return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns,
            value.st_nlink,value.st_uid,value.st_gid,stat.S_IMODE(value.st_mode))
def open_file(path,mode):
    parent=os.open("/",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        components=path.split("/")[1:]
        for component in components[:-1]:
            assert component and component not in (".","..")
            child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            os.close(parent); parent=child
        name=components[-1]; before=os.stat(name,dir_fd=parent,follow_symlinks=False)
        assert stat.S_ISREG(before.st_mode) and before.st_nlink==1
        assert (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))==(os.getuid(),os.getgid(),mode)
        descriptor=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
        opened=os.fstat(descriptor); assert identity(opened)==identity(before)
        return parent,name,descriptor,opened
    except BaseException:
        os.close(parent); raise
def read_all(descriptor,metadata):
    result=bytearray(); offset=0
    while offset<metadata.st_size:
        block=os.pread(descriptor,min(1024*1024,metadata.st_size-offset),offset); assert block
        result.extend(block); offset+=len(block)
    assert identity(os.fstat(descriptor))==identity(metadata)
    return bytes(result)
def seal(payload,mode):
    required=(fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE)
    descriptor=os.memfd_create("revival-held-exec",os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
    try:
        offset=0
        while offset<len(payload): offset+=os.write(descriptor,payload[offset:])
        os.fchmod(descriptor,mode); fcntl.fcntl(descriptor,fcntl.F_ADD_SEALS,required)
        assert fcntl.fcntl(descriptor,fcntl.F_GET_SEALS)&required==required
        return descriptor
    except BaseException:
        os.close(descriptor); raise
manifest_parent,manifest_name,manifest_fd,manifest_meta=open_file(manifest,0o600)
helper_parent=helper=sealed=None
try:
    body=json.loads(read_all(manifest_fd,manifest_meta)); assert body.get("releaseId")==release_id
    matches=[item for item in body.get("entries",[]) if item.get("path")=="platform/deploy/vps/remote/held-release-exec.py"]
    assert len(matches)==1 and matches[0].get("mode") in ("0644","0755")
    expected=matches[0]
    helper_parent,helper_name,helper,opened=open_file(helper_path,int(expected["mode"],8))
    payload=read_all(helper,opened)
    assert len(payload)==expected["size"] and hashlib.sha256(payload).hexdigest()==expected["sha256"]
    sealed=seal(payload,int(expected["mode"],8))
    result=subprocess.run(["/usr/bin/python3","-I","-B",f"/proc/self/fd/{sealed}","--tree",tree,
                           "--manifest",manifest,"--expect-release-id",release_id,
                           "--entry",entry,"--interpreter",interpreter,"--",*arguments],
                          check=False,pass_fds=(sealed,helper,manifest_fd))
    assert identity(os.fstat(helper))==identity(opened)
    assert identity(os.stat(helper_name,dir_fd=helper_parent,follow_symlinks=False))==identity(opened)
    assert identity(os.fstat(manifest_fd))==identity(manifest_meta)
    assert identity(os.stat(manifest_name,dir_fd=manifest_parent,follow_symlinks=False))==identity(manifest_meta)
    raise SystemExit(result.returncode)
finally:
    for value in (sealed,helper,helper_parent,manifest_fd,manifest_parent):
        if isinstance(value,int):
            try: os.close(value)
            except OSError: pass
PY
}
candidate_verification="$(run_held_bootstrap_entry platform/deploy/release-candidate.mjs node \
  verify --candidate "$candidate_root" --expect-id "$candidate_id" --json)" \
  || { echo 'release bootstrap failed: candidate verification refused before Docker' >&2; exit 1; }
/usr/bin/node -e 'const value=JSON.parse(process.argv[1]);if(value.ok!==true||value.candidateId!==process.argv[2]||value.releaseId!==process.argv[3]||value.productionCompatible!==true||value.authority?.origin!=="github-hosted-actions"||value.authority?.productionUse!=="requires-point-of-use-provider-evidence")process.exit(1)' \
  "$candidate_verification" "$candidate_id" "$release_id" \
  || { echo 'release bootstrap failed: candidate is not the requested Carry-compatible release' >&2; exit 1; }
# Refuse SSH-forwarded daemon/context/config state, then pin every preflight and
# deploy Docker/Compose call to the production host's local Unix socket.
inherited_docker=("${!DOCKER_@}")
((${#inherited_docker[@]} == 0)) \
  || { echo 'release bootstrap failed: ambient DOCKER_* selection is forbidden' >&2; exit 1; }
docker_config="$remote_root/private/docker-cli-empty"
if [[ ! -e "$remote_root/private" && ! -L "$remote_root/private" ]]; then mkdir -m 700 -- "$remote_root/private"; fi
[[ -d "$remote_root/private" && ! -L "$remote_root/private" \
  && "$(readlink -f -- "$remote_root/private")" == "$remote_root/private" \
  && "$(stat -c '%a:%u:%g' "$remote_root/private")" == "700:$(id -u):$(id -g)" ]] \
  || { echo 'release bootstrap failed: private Docker anchor parent is unsafe' >&2; exit 1; }
if [[ ! -e "$docker_config" && ! -L "$docker_config" ]]; then mkdir -m 700 -- "$docker_config"; fi
[[ -d "$docker_config" && ! -L "$docker_config" \
  && "$(readlink -f -- "$docker_config")" == "$docker_config" \
  && "$(stat -c '%a:%u:%g' "$docker_config")" == "700:$(id -u):$(id -g)" \
  && -z "$(find "$docker_config" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
  || { echo 'release bootstrap failed: Docker config anchor is unsafe' >&2; exit 1; }
export DOCKER_HOST=unix:///var/run/docker.sock DOCKER_CONFIG="$docker_config"
export REVIVAL_REMOTE_ROOT="$remote_root"
export REVIVAL_EXPECTED_HOST="$expected_host"
export REVIVAL_EXPECTED_USER="$expected_user"
export REVIVAL_EXPECTED_ARCH="$expected_arch"
preflight_args=(--min-free-gb "$min_free_gb" --archive-bytes "$archive_bytes")
[[ "$cleanup" == 0 ]] || preflight_args+=(--cleanup-project-images)
run_held_bootstrap_entry platform/deploy/vps/remote/preflight.sh bash "${preflight_args[@]}"
deploy_args=(
  --release-id "$release_id"
  --archive "$archive"
  --manifest "$manifest"
  --verifier "$verifier"
  --deployment-id "$deployment_id"
  --candidate-id "$candidate_id"
  --candidate-root "$candidate_root"
  --deployment-authority-sha256 "$deployment_authority_sha256"
)
[[ "$emit_json" == 0 ]] || deploy_args+=(--json)
[[ "$skip_smoke" == 0 ]] || deploy_args+=(--skip-staging-smoke)
status=0
run_held_bootstrap_entry platform/deploy/vps/remote/deploy.sh bash "${deploy_args[@]}" || status=$?
# The selected driver cannot move the workspace containing its own logical
# release root while it is still running.  After it exits, stream the exact
# trusted candidate-store helper into an isolated interpreter and use its
# descriptor-held, watcher-linearized, non-destructive receipt protocol.  The
# child status remains authoritative; a cleanup refusal only replaces a zero
# child status, while a failed child keeps its original code for diagnosis.
cleanup_status=0
cleanup_receipt=""
if [[ -e "$incoming" || -L "$incoming" ]]; then
  cleanup_receipt="$(
    /usr/bin/python3 -I -B - retire-path --parent "$remote_root/incoming" --name "$release_id" <<'__REVIVAL_CANDIDATE_STORE__'
BOOTSTRAP
    cat "$REVIVAL_ROOT/platform/deploy/candidate-store.py"
    cat <<'BOOTSTRAP'
__REVIVAL_CANDIDATE_STORE__
  )" || cleanup_status=$?
  if ((cleanup_status == 0)) && [[ ! "$cleanup_receipt" =~ ^\.candidate-retired-[0-9a-f]{32}$ ]]; then
    cleanup_status=1
  fi
fi
if ((cleanup_status != 0)); then
  printf 'release bootstrap warning: incoming workspace retirement refused\n' >&2
  ((status != 0)) || status=$cleanup_status
fi
exit "$status"
BOOTSTRAP
  } | run_ssh "$REMOTE_CLEAN_BASH -s -- $args"
}

run_current_release_operation() {
  local operation="$1"
  shift
  case "$operation" in backup.sh|rollback.sh|canary.sh|drift.sh) ;;
    *) usage_error "unsupported stateful release operation" ;;
  esac
  local args
  args="$(remote_quote "$operation" "$@")"
  run_ssh "$REMOTE_CLEAN_BASH -s -- $args" <<'BOOTSTRAP'
set -euo pipefail
umask 077
operation="$1"; shift
root=/home/anders/ai-pin-revival
[[ "$(hostname -s)" == anders-server && "$(id -un)" == anders ]] || exit 1
case "$(uname -m)" in aarch64|arm64) ;; *) exit 1;; esac
case "$operation" in backup.sh|rollback.sh|canary.sh|drift.sh) ;; *) exit 64;; esac
if [[ "$operation" == backup.sh || "$operation" == canary.sh || "$operation" == drift.sh ]]; then
  [[ -d "$root" && ! -L "$root" ]] || exit 1
  exec 9>"$root/deploy.lock"
  flock -n 9 || { echo 'stateful operation lock is held' >&2; exit 1; }
fi
resume_rollback=0
if [[ "$operation" == rollback.sh ]]; then
  pending=(); foreign=()
  for candidate in "$root/deployments"/*; do
    [[ -d "$candidate" && ! -L "$candidate" ]] || continue
    if [[ -f "$candidate/POINTER_TRANSACTION_PREPARED" \
      && ! -f "$candidate/POINTER_TRANSACTION_ABORTED" \
      && ( ! -f "$candidate/POINTER_TRANSACTION_COMMITTED" || ! -f "$candidate/SUCCEEDED" ) ]]; then
      foreign+=("deploy:$candidate")
    fi
    [[ -d "$candidate" && ! -L "$candidate" && -f "$candidate/ROLLBACK_POINTER_TRANSACTION_PREPARED" \
      && ! -f "$candidate/ROLLBACK_POINTER_TRANSACTION_ABORTED" \
      && ! -f "$candidate/MANUAL_ROLLBACK" ]] || continue
    pending+=("$candidate")
  done
  ((${#foreign[@]} == 0)) || { echo 'a deploy authority transaction is pending; rollback dispatch refused' >&2; exit 1; }
  ((${#pending[@]} <= 1)) || { echo 'multiple authority transactions require operator recovery' >&2; exit 1; }
  if ((${#pending[@]} == 1)); then
    record="${pending[0]}"
    release_id="$(tr -d '\r\n' <"$record/release-id")"
    [[ "$release_id" =~ ^[0-9a-f]{64}$ ]] || exit 1
    release="$root/releases/$release_id"
    resume_rollback=1
  fi
fi
if ((resume_rollback == 0)); then
  [[ -L "$root/current" && -L "$root/current-deployment" ]] || exit 1
  release="$(readlink -f "$root/current")"; record="$(readlink -f "$root/current-deployment")"
fi
[[ "$release" == "$root/releases/"* && -d "$release" && "$record" == "$root/deployments/"* && -d "$record" ]] || exit 1
release_id="$(basename "$release")"; [[ "$release_id" =~ ^[0-9a-f]{64}$ ]] || exit 1
[[ -f "$record/SUCCEEDED" && -f "$record/INGRESS_ACTIVATED" \
  && -f "$record/POINTER_TRANSACTION_COMMITTED" && ! -f "$record/MANUAL_ROLLBACK" \
  && "$(tr -d '\r\n' <"$record/release-id")" == "$release_id" ]] || exit 1
manifest="$root/manifests/$release_id.json"
held_exec="$release/platform/deploy/vps/remote/held-release-exec.py"
held_arguments=()
if [[ "$operation" == canary.sh || "$operation" == drift.sh ]]; then
  entry="platform/deploy/vps/remote/current-operation.sh"
  held_arguments+=(--operation "$operation" --record "$record" --)
else
  entry="platform/deploy/vps/remote/$operation"
  [[ "$operation" != backup.sh ]] || held_arguments+=(--already-locked)
fi
exec /usr/bin/python3 -I -B - "$manifest" "$held_exec" "$release" "$release_id" "$entry" \
  "${held_arguments[@]}" "$@" <<'PY'
import fcntl,hashlib,json,os,stat,subprocess,sys
manifest_path,helper_path,tree,expected,entry,*arguments=sys.argv[1:]
def identity(value):
    return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns,
            value.st_nlink,value.st_uid,value.st_gid,stat.S_IMODE(value.st_mode))
def open_file(path,mode):
    assert os.path.isabs(path) and os.path.normpath(path)==path
    parent=os.open("/",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        components=path.split("/")[1:]
        for component in components[:-1]:
            assert component and component not in (".","..")
            child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            os.close(parent); parent=child
        name=components[-1]
        before=os.stat(name,dir_fd=parent,follow_symlinks=False)
        assert stat.S_ISREG(before.st_mode) and before.st_nlink==1
        assert (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))==(os.getuid(),os.getgid(),mode)
        descriptor=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
        opened=os.fstat(descriptor)
        assert identity(opened)==identity(before)
        return parent,name,descriptor,opened
    except BaseException:
        os.close(parent); raise
def read_all(descriptor,metadata):
    result=bytearray(); offset=0
    while offset < metadata.st_size:
        block=os.pread(descriptor,min(1024*1024,metadata.st_size-offset),offset)
        assert block
        result.extend(block); offset+=len(block)
    assert identity(os.fstat(descriptor))==identity(metadata)
    return bytes(result)
def seal(payload,mode):
    required=(fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE)
    descriptor=os.memfd_create("revival-held-exec",os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
    try:
        offset=0
        while offset<len(payload): offset+=os.write(descriptor,payload[offset:])
        os.fchmod(descriptor,mode); fcntl.fcntl(descriptor,fcntl.F_ADD_SEALS,required)
        assert fcntl.fcntl(descriptor,fcntl.F_GET_SEALS)&required==required
        return descriptor
    except BaseException:
        os.close(descriptor); raise
assert len(expected)==64 and all(value in "0123456789abcdef" for value in expected)
manifest_parent,manifest_name,manifest_fd,manifest_meta=open_file(manifest_path,0o600)
helper_parent=helper_fd=sealed_fd=None
try:
    body=json.loads(read_all(manifest_fd,manifest_meta))
    assert set(body)=={"schemaVersion","profile","releaseId","entries"}
    canonical={"schemaVersion":body.get("schemaVersion"),"profile":body.get("profile"),"entries":body.get("entries")}
    assert body.get("schemaVersion")==1 and body.get("profile")=="vps" and body.get("releaseId")==expected
    assert hashlib.sha256(json.dumps(canonical,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()==expected
    matching=[value for value in body["entries"] if isinstance(value,dict) and value.get("path")=="platform/deploy/vps/remote/held-release-exec.py"]
    assert len(matching)==1 and set(matching[0])=={"path","sha256","size","mode"}
    helper_entry=matching[0]
    assert helper_entry["mode"] in ("0644","0755")
    helper_parent,helper_name,helper_fd,helper_meta=open_file(helper_path,int(helper_entry["mode"],8))
    helper_bytes=read_all(helper_fd,helper_meta)
    assert len(helper_bytes)==helper_entry["size"]
    assert hashlib.sha256(helper_bytes).hexdigest()==helper_entry["sha256"]
    sealed_fd=seal(helper_bytes,int(helper_entry["mode"],8))
    command=["/usr/bin/python3","-I","-B",f"/proc/self/fd/{sealed_fd}","--tree",tree,
             "--manifest",manifest_path,"--expect-release-id",expected,"--entry",entry,
             "--interpreter","bash","--",*arguments]
    result=subprocess.run(command,check=False,pass_fds=(sealed_fd,helper_fd,manifest_fd))
    assert identity(os.fstat(manifest_fd))==identity(manifest_meta)
    assert identity(os.stat(manifest_name,dir_fd=manifest_parent,follow_symlinks=False))==identity(manifest_meta)
    assert identity(os.fstat(helper_fd))==identity(helper_meta)
    assert identity(os.stat(helper_name,dir_fd=helper_parent,follow_symlinks=False))==identity(helper_meta)
    raise SystemExit(result.returncode)
finally:
    for value in (sealed_fd,helper_fd,helper_parent,manifest_fd,manifest_parent):
        if isinstance(value,int):
            try: os.close(value)
            except OSError: pass
PY
BOOTSTRAP
}

assert_local_workspace() {
  [[ -f "$REVIVAL_ROOT/compose.yaml" ]] || die "not inside the Ai Pin Revival workspace"
  [[ -f "$REVIVAL_ROOT/platform/deploy/release.mjs" ]] || die "release packager is unavailable"
  [[ -f "$REVIVAL_ROOT/platform/compose/production.yaml" ]] || die "production Compose model is unavailable"
}

json_field() {
  local json_file="$1" field="$2"
  run_local_node - "$json_file" "$field" <<'NODE'
const fs = require('node:fs');
const [path, field] = process.argv.slice(2);
const payload = fs.readFileSync(path, 'utf8');
const match = payload.match(/\{[\s\S]*\}\s*$/);
if (!match) process.exit(2);
const data = JSON.parse(match[0]);
const value = data[field];
if (typeof value !== 'string' || value.length === 0) process.exit(2);
process.stdout.write(value);
NODE
}

validate_release_id() {
  [[ "$1" =~ ^[0-9a-f]{64}$ ]] || die "releaseId must be a lowercase SHA-256 digest"
}

absolute_existing_file() {
  local candidate="$1"
  [[ -f "$candidate" ]] || die "file does not exist: $candidate"
  (cd -- "$(dirname -- "$candidate")" && printf '%s/%s\n' "$PWD" "$(basename -- "$candidate")")
}

local_preflight() {
  need_local ssh
  need_local node
  need_local python3
  need_local rsync
  if [[ -n "${REVIVAL_LOCAL_SHA256SUM:-}" ]]; then need_local sha256sum; else need_local shasum; fi
  need_local awk
  assert_local_workspace
  validate_remote_root "$REMOTE_ROOT"
}

local_sha256_file() {
  local file="$1"
  [[ -f "$file" && ! -L "$file" ]] || die "checksum input is not one regular file: $file"
  if [[ -n "${REVIVAL_LOCAL_SHA256SUM:-}" ]]; then
    "${REVIVAL_LOCAL_SHA256SUM:?}" -- "$file" | "${REVIVAL_LOCAL_AWK:?}" '{print $1}'
  elif [[ -n "${REVIVAL_LOCAL_SHASUM:-}" ]]; then
    "${REVIVAL_LOCAL_SHASUM:?}" -a 256 -- "$file" | "${REVIVAL_LOCAL_AWK:?}" '{print $1}'
  else
    die "required local command is unavailable: sha256sum or shasum"
  fi
}

# Transfer one already-snapshotted candidate. The partial directory is retained
# between attempts so a dropped connection resumes the same bytes. Success is
# not rsync's exit status alone: the remote must hash every listed file and ACK
# the exact local transport-manifest digest.
transfer_candidate_resumably() {
  local source="$1" remote_partial="$2" expected_ack="$3"
  local attempt remote_ack remote_args remote_shell
  [[ -d "$source" && "$remote_partial" == "$REMOTE_ROOT/incoming/"*/.candidate-*.partial \
    && "$expected_ack" =~ ^[0-9a-f]{64}$ ]] || usage_error "invalid candidate transfer arguments"
  for attempt in 1 2 3; do
    [[ -z "$UPLOAD_LEASE_PID" ]] || assert_remote_upload_lease
    remote_shell="$(rsync_remote_shell)"
    if run_local_rsync --rsh "$remote_shell" --archive --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= --partial --append-verify --protect-args \
        -- "$source/" "$DEPLOY_REMOTE:$remote_partial/"; then
      remote_ack=""
      remote_args="$(remote_quote "$remote_partial")"
      if remote_ack="$(run_ssh "$REMOTE_CLEAN_BASH -s -- $remote_args" <<'REMOTE_ACK'
set -euo pipefail
cd -- "$1"
/usr/bin/sha256sum -c transport.sha256 >/dev/null
/usr/bin/sha256sum transport.sha256 | /usr/bin/awk '{print $1}'
REMOTE_ACK
)"; then
        if [[ "$remote_ack" == "$expected_ack" ]]; then
          [[ -z "$UPLOAD_LEASE_PID" ]] || assert_remote_upload_lease
          return 0
        fi
      fi
    fi
  done
  die "candidate transfer failed after exactly 3 resumable attempts"
}
