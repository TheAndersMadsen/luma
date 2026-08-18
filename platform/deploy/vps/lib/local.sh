#!/usr/bin/env bash
# Shared local-side helpers for the guarded anders-server deployment drivers.
# This file must never read or print production environment files.
set -euo pipefail

VPS_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
VPS_DIR="$(cd -- "$VPS_LIB_DIR/.." && pwd -P)"
REVIVAL_ROOT="$(cd -- "$VPS_DIR/../../.." && pwd -P)"
REMOTE_IMPL="$VPS_DIR/remote"

DEPLOY_REMOTE="${REVIVAL_DEPLOY_REMOTE:-vps}"
REMOTE_ROOT="/home/anders/ai-pin-revival"
EXPECTED_HOST="anders-server"
EXPECTED_USER="anders"
EXPECTED_ARCH="aarch64"

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
  command -v "$1" >/dev/null 2>&1 || die "required local command is unavailable: $1"
}

require_safe_remote_name() {
  [[ "$DEPLOY_REMOTE" =~ ^[A-Za-z0-9._@:-]+$ ]] || usage_error "unsafe SSH target"
}

run_ssh() {
  require_safe_remote_name
  ssh \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=2 \
    "$DEPLOY_REMOTE" "$@"
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
BOOTSTRAP
    printf 'cat <<'"'"'__REVIVAL_ENTRYPOINT__'"'"' > "$tmp_dir/%s"\n' "$implementation"
    cat "$REMOTE_IMPL/$implementation"
    cat <<'BOOTSTRAP'
__REVIVAL_ENTRYPOINT__
chmod 600 "$tmp_dir/common.sh" "$tmp_dir/domain.sh" "$tmp_dir/domain.py" "$tmp_dir/transaction.py" \
  "$tmp_dir/adopt-config.py" "$tmp_dir/prune-state.py"
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
    printf 'bash "$tmp_dir/%s" "$@" || status=$?\n' "$implementation"
    printf 'exit "$status"\n'
  } | run_ssh "bash -s -- $args"
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
  node - "$manifest" "$expected_release_id" \
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
  node - "$archive" "$manifest" "$expected_release_id" "$member" "$destination" <<'NODE'
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
  node - "$source" "$destination" <<'NODE'
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
  run_ssh "bash -s -- $args" <<'REMOTE'
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
  validate_release_id "$release_id"
  validate_remote_root "$REMOTE_ROOT"
  [[ "$min_free_gb" =~ ^[0-9]+$ && "$archive_bytes" =~ ^[0-9]+$ && "$cleanup" =~ ^[01]$ \
     && "$json" =~ ^[01]$ && "$skip_smoke" =~ ^[01]$ ]] \
    || usage_error "invalid selected-release deployment arguments"
  local args
  args="$(remote_quote \
    "$release_id" "$REMOTE_ROOT" "$incoming" "$archive" "$manifest" "$verifier" \
    "$deployment_id" "$min_free_gb" "$archive_bytes" "$cleanup" "$json" \
    "$EXPECTED_HOST" "$EXPECTED_USER" "$EXPECTED_ARCH" "$skip_smoke")"
  {
    cat <<'BOOTSTRAP'
set -euo pipefail
umask 077
release_id="$1"; remote_root="$2"; incoming="$3"; archive="$4"; manifest="$5"; verifier="$6"
deployment_id="$7"; min_free_gb="$8"; archive_bytes="$9"; cleanup="${10}"; emit_json="${11}"
expected_host="${12}"; expected_user="${13}"; expected_arch="${14}"; skip_smoke="${15:-0}"
[[ "$release_id" =~ ^[0-9a-f]{64}$ ]] || { echo 'release bootstrap failed: invalid release id' >&2; exit 1; }
[[ "$incoming" == "$remote_root/incoming/$release_id" ]] || { echo 'release bootstrap failed: invalid incoming directory' >&2; exit 1; }
for path in "$archive" "$manifest" "$verifier"; do
  [[ "$path" == "$incoming/"* && -f "$path" && ! -L "$path" ]] \
    || { echo 'release bootstrap failed: invalid input path' >&2; exit 1; }
done
driver_root="$incoming/verified-driver"
verification="$incoming/bootstrap-verification.json"
if [[ -e "$driver_root" || -L "$driver_root" ]]; then
  [[ -d "$driver_root" && ! -L "$driver_root" ]] \
    || { echo 'release bootstrap failed: invalid existing driver target' >&2; exit 1; }
  python3 "$verifier" --tree "$driver_root" --manifest "$manifest" \
    --expect-release-id "$release_id" --json >"$verification"
else
  python3 "$verifier" --archive "$archive" --manifest "$manifest" \
    --extract "$driver_root" --expect-release-id "$release_id" --json >"$verification"
fi
python3 "$verifier" --tree "$driver_root" --manifest "$manifest" \
  --expect-release-id "$release_id" --json >>"$verification"
driver="$driver_root/platform/deploy/vps/remote/deploy.sh"
common="$driver_root/platform/deploy/vps/remote/common.sh"
preflight="$driver_root/platform/deploy/vps/remote/preflight.sh"
[[ -f "$driver" && ! -L "$driver" && -f "$common" && ! -L "$common" && \
   -f "$preflight" && ! -L "$preflight" ]] \
  || { echo 'release bootstrap failed: verified driver is incomplete' >&2; exit 1; }
export REVIVAL_REMOTE_ROOT="$remote_root"
export REVIVAL_EXPECTED_HOST="$expected_host"
export REVIVAL_EXPECTED_USER="$expected_user"
export REVIVAL_EXPECTED_ARCH="$expected_arch"
preflight_args=(--min-free-gb "$min_free_gb" --archive-bytes "$archive_bytes")
[[ "$cleanup" == 0 ]] || preflight_args+=(--cleanup-project-images)
bash "$preflight" "${preflight_args[@]}"
deploy_args=(
  --release-id "$release_id"
  --archive "$archive"
  --manifest "$manifest"
  --verifier "$verifier"
  --deployment-id "$deployment_id"
)
[[ "$emit_json" == 0 ]] || deploy_args+=(--json)
[[ "$skip_smoke" == 0 ]] || deploy_args+=(--skip-staging-smoke)
exec bash "$driver" "${deploy_args[@]}"
BOOTSTRAP
  } | run_ssh "bash -s -- $args"
}

run_current_release_operation() {
  local operation="$1"
  shift
  case "$operation" in backup.sh|rollback.sh|canary.sh|drift.sh) ;;
    *) usage_error "unsupported stateful release operation" ;;
  esac
  local args
  args="$(remote_quote "$operation" "$@")"
  run_ssh "bash -s -- $args" <<'BOOTSTRAP'
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
manifest="$root/manifests/$release_id.json"; verifier="$release/platform/deploy/vps/verify-release.py"
[[ -f "$manifest" && -f "$verifier" && ! -L "$verifier" ]] || exit 1
# The release verifier cannot authenticate itself. Bind the authoritative
# manifest and the verifier bytes independently before allowing it to verify
# and dispatch the rest of the release tree.
python3 - "$manifest" "$verifier" "$release_id" <<'PY'
import hashlib,json,os,stat,sys
manifest_path,verifier_path,expected=sys.argv[1:]
for path in (manifest_path,verifier_path):
    metadata=os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit("stateful bootstrap input is not a regular file")
with open(manifest_path,"r",encoding="utf-8") as stream:
    manifest=json.load(stream)
if set(manifest) != {"schemaVersion","profile","releaseId","entries"}:
    raise SystemExit("stateful bootstrap manifest schema mismatch")
payload={"schemaVersion":manifest.get("schemaVersion"),"profile":manifest.get("profile"),"entries":manifest.get("entries")}
calculated=hashlib.sha256(json.dumps(payload,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
if manifest.get("schemaVersion") != 1 or manifest.get("profile") != "vps" or manifest.get("releaseId") != expected or calculated != expected:
    raise SystemExit("stateful bootstrap manifest identity mismatch")
entries=[entry for entry in manifest.get("entries",[]) if isinstance(entry,dict) and entry.get("path")=="platform/deploy/vps/verify-release.py"]
if len(entries) != 1 or set(entries[0]) != {"path","sha256","size","mode"}:
    raise SystemExit("stateful bootstrap verifier entry mismatch")
entry=entries[0]; metadata=os.lstat(verifier_path)
if entry.get("mode") not in {"0644","0755"} or entry.get("size") != metadata.st_size or entry.get("mode") != f"{stat.S_IMODE(metadata.st_mode):04o}":
    raise SystemExit("stateful bootstrap verifier metadata mismatch")
descriptor=os.open(verifier_path,os.O_RDONLY|os.O_NOFOLLOW)
try:
    opened=os.fstat(descriptor)
    if (opened.st_dev,opened.st_ino,opened.st_size) != (metadata.st_dev,metadata.st_ino,metadata.st_size):
        raise SystemExit("stateful bootstrap verifier changed before open")
    digest=hashlib.file_digest(os.fdopen(descriptor,"rb",closefd=False),"sha256").hexdigest()
finally:
    os.close(descriptor)
after=os.lstat(verifier_path)
if (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) != (metadata.st_dev,metadata.st_ino,metadata.st_size,metadata.st_mtime_ns,metadata.st_ctime_ns):
    raise SystemExit("stateful bootstrap verifier changed while hashing")
if not isinstance(entry.get("sha256"),str) or digest != entry["sha256"]:
    raise SystemExit("stateful bootstrap verifier digest mismatch")
PY
python3 "$verifier" --tree "$release" --manifest "$manifest" --expect-release-id "$release_id" --json >/dev/null
entry="$release/platform/deploy/vps/remote/$operation"; common="$release/platform/deploy/vps/remote/common.sh"
[[ -f "$entry" && ! -L "$entry" && -f "$common" && ! -L "$common" ]] || exit 1
if [[ "$operation" == backup.sh ]]; then exec bash "$entry" --already-locked "$@"; fi
exec bash "$entry" "$@"
BOOTSTRAP
}

assert_local_workspace() {
  [[ -f "$REVIVAL_ROOT/compose.yaml" ]] || die "not inside the Ai Pin Revival workspace"
  [[ -f "$REVIVAL_ROOT/platform/deploy/release.mjs" ]] || die "release packager is unavailable"
  [[ -f "$REVIVAL_ROOT/platform/compose/production.yaml" ]] || die "production Compose model is unavailable"
}

json_field() {
  local json_file="$1" field="$2"
  node - "$json_file" "$field" <<'NODE'
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
  need_local scp
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || die "required local command is unavailable: sha256sum or shasum"
  assert_local_workspace
  validate_remote_root "$REMOTE_ROOT"
}
