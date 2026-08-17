#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/lib/local.sh"

dry_run=0
cleanup=0
release_json=""
json=0
min_free_gb=8
skip_smoke=0
usage() {
  cat >&2 <<EOF
usage: $0 [--remote vps] [--dry-run] [--release-json FILE]
          [--cleanup-project-images] [--min-free-gb N] [--json]
          [--skip-staging-smoke]
EOF
  exit 64
}
while (($#)); do
  case "$1" in
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --release-json) (($# >= 2)) || usage; release_json="$2"; shift 2 ;;
    --cleanup-project-images) cleanup=1; shift ;;
    --min-free-gb) (($# >= 2)) || usage; min_free_gb="$2"; shift 2 ;;
    --json) json=1; shift ;;
    # Skips the isolated rehearsal only; the backup, canaries, drift check and
    # rollback all still run. See remote/deploy.sh for why this exists.
    --skip-staging-smoke) skip_smoke=1; shift ;;
    *) usage ;;
  esac
done
local_preflight

snapshot_dir="$(mktemp -d)"
chmod 700 "$snapshot_dir"
temporary_json=""
cleanup_local() {
  local status=$?
  trap - EXIT
  [[ -z "$snapshot_dir" || ! -e "$snapshot_dir" ]] || rm -rf -- "$snapshot_dir" || status=1
  exit "$status"
}
trap cleanup_local EXIT
if [[ -z "$release_json" ]]; then
  [[ -n "${REVIVAL_DATA_DIR:-}" ]] || usage_error "--release-json is required unless REVIVAL_DATA_DIR names an external release-data directory"
  [[ "$REVIVAL_DATA_DIR" == /* && "$REVIVAL_DATA_DIR" != "$REVIVAL_ROOT" && "$REVIVAL_DATA_DIR" != "$REVIVAL_ROOT/"* ]] \
    || usage_error "REVIVAL_DATA_DIR must be an absolute path outside the source workspace"
  temporary_json="$snapshot_dir/built-release.json"
  mkdir -p -- "$REVIVAL_DATA_DIR/releases"
  (
    cd "$REVIVAL_ROOT"
    node platform/deploy/release.mjs build --profile vps --output "$REVIVAL_DATA_DIR/releases" --json
  ) >"$temporary_json"
  release_json="$temporary_json"
else
  release_json="$(absolute_existing_file "$release_json")"
fi

snapshot_regular_file "$release_json" "$snapshot_dir/release.json"
release_json="$snapshot_dir/release.json"
release_id="$(json_field "$release_json" releaseId)"
archive_source="$(json_field "$release_json" archivePath)"
manifest_source="$(json_field "$release_json" manifestPath)"
validate_release_id "$release_id"
[[ "$archive_source" == /* ]] || archive_source="$REVIVAL_ROOT/$archive_source"
[[ "$manifest_source" == /* ]] || manifest_source="$REVIVAL_ROOT/$manifest_source"
archive_source="$(absolute_existing_file "$archive_source")"
manifest_source="$(absolute_existing_file "$manifest_source")"
archive="$snapshot_dir/release.tar.gz"
manifest="$snapshot_dir/release.manifest.json"
snapshot_regular_file "$archive_source" "$archive"
snapshot_regular_file "$manifest_source" "$manifest"
verify_json="$snapshot_dir/verify.json"
(
  cd "$REVIVAL_ROOT"
  node platform/deploy/release.mjs verify --archive "$archive" --manifest "$manifest" --json
) >"$verify_json"
node - "$verify_json" "$release_id" <<'NODE'
const fs = require('node:fs');
const [path, expected] = process.argv.slice(2);
const payload = fs.readFileSync(path, 'utf8').trim();
const match = payload.match(/\{[\s\S]*\}\s*$/);
if (!match) {
  console.error('verified package output has no JSON object');
  process.exit(1);
}
const result = JSON.parse(match[0]);
if (result.ok !== true || result.profile !== 'vps' || result.releaseId !== expected) {
  console.error('verified package identity does not match the release descriptor');
  process.exit(1);
}
NODE
assert_release_bootstrap_contract "$manifest" "$release_id"
selected_verifier="$snapshot_dir/verify-release.py"
install -m 600 /dev/null "$selected_verifier"
materialize_release_member "$archive" "$manifest" "$release_id" "$RELEASE_VERIFIER_PATH" "$selected_verifier"
python3 "$selected_verifier" --archive "$archive" --manifest "$manifest" \
  --expect-release-id "$release_id" --json >/dev/null
archive_bytes="$(stat -f '%z' "$archive" 2>/dev/null || stat -c '%s' "$archive")"

preflight_args=(--min-free-gb "$min_free_gb" --archive-bytes "$archive_bytes")

if ((dry_run)); then
  ((cleanup == 0)) || usage_error "--cleanup-project-images is unavailable with --dry-run"
  # Dry-run intentionally runs only the reviewable, non-cutover preflight from
  # the workspace and cannot request image cleanup. Actual deployments run the
  # preflight from the selected, verified release tree inside the bootstrap.
  run_remote_impl preflight.sh "${preflight_args[@]}"
  if ((json)); then
    node - "$release_id" "$archive" "$manifest" "$DEPLOY_REMOTE" "$REMOTE_ROOT" <<'NODE'
const [releaseId,archivePath,manifestPath,target,remoteRoot]=process.argv.slice(2);
console.log(JSON.stringify({ok:true,dryRun:true,releaseId,archivePath,manifestPath,target,remoteRoot}));
NODE
  else
    printf 'dry-run passed: release=%s target=%s root=%s\n' "$release_id" "$DEPLOY_REMOTE" "$REMOTE_ROOT"
  fi
  exit 0
fi

incoming="$REMOTE_ROOT/incoming/$release_id"
remote_preupload_gate "$release_id" "$min_free_gb" "$archive_bytes" "$incoming"
run_ssh "umask 077; \
  if test -e '$REMOTE_ROOT' || test -L '$REMOTE_ROOT'; then test -d '$REMOTE_ROOT' && test ! -L '$REMOTE_ROOT'; else install -d -m 700 '$REMOTE_ROOT'; fi; \
  if test -e '$REMOTE_ROOT/incoming' || test -L '$REMOTE_ROOT/incoming'; then test -d '$REMOTE_ROOT/incoming' && test ! -L '$REMOTE_ROOT/incoming'; else install -d -m 700 '$REMOTE_ROOT/incoming'; fi; \
  test ! -e '$incoming' && test ! -L '$incoming'; install -d -m 700 '$incoming'"
scp -q -- "$archive" "$DEPLOY_REMOTE:$incoming/release.tar.gz"
scp -q -- "$manifest" "$DEPLOY_REMOTE:$incoming/release.manifest.json"
scp -q -- "$selected_verifier" "$DEPLOY_REMOTE:$incoming/verify-release.py"
run_ssh "chmod 600 '$incoming/release.tar.gz' '$incoming/release.manifest.json'; chmod 700 '$incoming/verify-release.py'"

deployment_id="$(date -u +%Y%m%dT%H%M%SZ)-${release_id:0:12}"
run_verified_release_deploy \
  "$release_id" "$incoming" "$incoming/release.tar.gz" "$incoming/release.manifest.json" \
  "$incoming/verify-release.py" "$deployment_id" "$min_free_gb" "$archive_bytes" "$cleanup" "$json" \
  "$skip_smoke"
