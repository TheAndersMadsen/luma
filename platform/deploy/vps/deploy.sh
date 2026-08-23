#!/usr/bin/env -S /bin/bash -p
set -euo pipefail
case "${BASH_SOURCE[0]}" in /*) SCRIPT_PATH="${BASH_SOURCE[0]}" ;; *) SCRIPT_PATH="$PWD/${BASH_SOURCE[0]}" ;; esac
SCRIPT_DIR="${SCRIPT_PATH%/*}"
builtin source "$SCRIPT_DIR/lib/local.sh"

# The one-time legacy predecessor registrar is a separate operator command and entry point,
# not an override flag accepted by `deploy production`.  It sources this shared
# candidate transport so provider verification, snapshotting, resumable upload,
# and the held-release bootstrap remain byte-identical.
deploy_operation=deploy
if ((${#BASH_SOURCE[@]} >= 2)) \
  && [[ "${BASH_SOURCE[1]}" == "$SCRIPT_DIR/register-legacy-predecessor.sh" ]]; then
  deploy_operation=register-legacy-predecessor
fi

dry_run=0 cleanup=0 confirm=0 json=0 min_free_gb=8 skip_smoke=0
candidate_path="" candidate_id_arg=""
usage() {
  cat >&2 <<EOF
usage: $0 [--remote vps] [--confirm | --dry-run] (--candidate PATH | --candidate-id SHA256)
          [--cleanup-project-images] [--min-free-gb N] [--json]
          [--skip-staging-smoke]
EOF
  exit 64
}
while (($#)); do
  case "$1" in
    --remote) (($# >= 2)) || usage; DEPLOY_REMOTE="$2"; shift 2 ;;
    --confirm) ((confirm == 0)) || usage; confirm=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --candidate) (($# >= 2)) || usage; candidate_path="$2"; shift 2 ;;
    --candidate-id) (($# >= 2)) || usage; candidate_id_arg="$2"; shift 2 ;;
    --release-json) usage_error "--release-json and implicit builds are retired; use --candidate or --candidate-id" ;;
    --cleanup-project-images) cleanup=1; shift ;;
    --min-free-gb) (($# >= 2)) || usage; min_free_gb="$2"; shift 2 ;;
    --json) json=1; shift ;;
    --skip-staging-smoke) skip_smoke=1; shift ;;
    *) usage ;;
  esac
done
[[ -z "$candidate_path" || -z "$candidate_id_arg" ]] || usage_error "select exactly one candidate"
[[ -n "$candidate_path" || -n "$candidate_id_arg" ]] || usage_error "an immutable candidate is required"
if ((dry_run)); then
  ((confirm == 0)) || usage_error "--dry-run cannot be combined with --confirm"
else
  ((confirm == 1)) || usage_error "production deployment requires one literal --confirm"
fi
if [[ "$deploy_operation" == register-legacy-predecessor ]]; then
  ((cleanup == 0 && skip_smoke == 0)) \
    || usage_error "legacy predecessor registration does not accept deployment cleanup or smoke overrides"
fi

# Candidate verification and the protected legacy production-state comparison intentionally
# precede local_preflight: neither SSH nor any remote command is reachable until
# the exact immutable input has passed both local gates.
snapshot_dir="$(mktemp -d)"
chmod 700 "$snapshot_dir"
cleanup_local() {
  local status=$?
  trap - EXIT
  if [[ -n "${UPLOAD_LEASE_PID:-}" ]]; then stop_remote_upload_lease 1 || status=1; fi
  [[ ! -e "$snapshot_dir" ]] || rm -rf -- "$snapshot_dir" || status=1
  exit "$status"
}
trap cleanup_local EXIT
if [[ -n "$candidate_id_arg" ]]; then
  [[ "$candidate_id_arg" =~ ^[0-9a-f]{64}$ ]] || usage_error "candidate ID must be a lowercase SHA-256 digest"
  [[ -n "${REVIVAL_DATA_DIR:-}" ]] || usage_error "--candidate-id requires REVIVAL_DATA_DIR"
  candidate_path="$REVIVAL_DATA_DIR/release-candidates/$candidate_id_arg"
fi

# A local candidate remains useful for build/verify/inspection, but it is not
# production authority.  Reopen the imported hosted evidence and rerun the
# fixed provider verifier at this exact point of use before copying candidate
# bytes or contacting the remote host.  The canonical result is carried with
# the transport and its digest is independently rechecked by the bootstrap and
# selected release.
deployment_authority="$snapshot_dir/deployment-authority.json"
authority_candidate_root="${candidate_path%/}"
[[ "${authority_candidate_root##*/}" != candidate.json ]] || authority_candidate_root="${authority_candidate_root%/*}"
authority_requested_id="${authority_candidate_root##*/}"
[[ "$authority_requested_id" =~ ^[0-9a-f]{64}$ ]] \
  || usage_error "hosted candidate path must be its content-addressed candidate ID directory"
hosted_authority_args=(
  authorize-deploy
  --candidate-id "$authority_requested_id"
  --candidate "$candidate_path"
  --json
)
[[ -z "${REVIVAL_DATA_DIR:-}" ]] || hosted_authority_args+=(--data-dir "$REVIVAL_DATA_DIR")
(
  cd "$REVIVAL_ROOT"
  run_local_node platform/deploy/hosted-vps-candidate.mjs "${hosted_authority_args[@]}"
) >"$deployment_authority"
chmod 600 "$deployment_authority"
authority_fields="$(cd "$REVIVAL_ROOT" && run_local_node --input-type=module - "$deployment_authority" "$candidate_path" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalStringify } from './platform/deploy/release-candidate.mjs';
const [recordPath, requestedPath] = process.argv.slice(2);
const fields = [
  'candidateId','candidateRoot','evidenceRoot','evidenceSha256','inventorySha256','manifestSha256',
  'ok','providerBundleSha256','providerEvidence','receiptSha256','releaseId','repository','runnerInvocationUri',
  'schema','sourceArchiveSha256','sourceDigest','sourceRef','sourceTree','verificationSha256','version',
].sort();
const before = fs.lstatSync(recordPath, { bigint: true });
if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
    Number(before.mode & 0o777n) !== 0o600 || before.uid !== BigInt(process.getuid()) || before.size <= 0n || before.size > 1024n * 1024n) {
  throw new Error('hosted deployment authority is not one bounded private regular file');
}
const source = fs.readFileSync(recordPath, 'utf8');
const after = fs.lstatSync(recordPath, { bigint: true });
for (const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink','mode','uid','gid']) {
  if (before[key] !== after[key]) throw new Error('hosted deployment authority moved while read');
}
let value;
try { value = JSON.parse(source); } catch { throw new Error('hosted deployment authority is not JSON'); }
if (source !== `${canonicalStringify(value)}\n` || Object.keys(value).sort().join(',') !== fields.join(',')) {
  throw new Error('hosted deployment authority is not canonical closed JSON');
}
const sha = /^[0-9a-f]{64}$/u;
const git = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const requested = path.resolve(requestedPath);
const requestedRoot = path.basename(requested) === 'candidate.json' ? path.dirname(requested) : requested;
if (value.schema !== 'revival.hosted-vps-candidate-authority' || value.version !== 1 || value.ok !== true ||
    !sha.test(value.candidateId) || !sha.test(value.releaseId) || !git.test(value.sourceDigest) || !git.test(value.sourceTree) ||
    !['sourceArchiveSha256','inventorySha256','receiptSha256','providerBundleSha256','verificationSha256','evidenceSha256','manifestSha256']
      .every((name) => sha.test(value[name])) ||
    value.repository !== 'TheAndersMadsen/ai-pin-revival' || value.sourceRef !== 'refs/heads/main' ||
    !/^https:\/\/github\.com\/TheAndersMadsen\/ai-pin-revival\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(value.runnerInvocationUri) ||
    value.providerEvidence !== 'point-of-use-reverified' || !path.isAbsolute(value.candidateRoot) ||
    !path.isAbsolute(value.evidenceRoot) || fs.realpathSync.native(requestedRoot) !== value.candidateRoot) {
  throw new Error('hosted deployment authority fields do not bind the selected candidate');
}
process.stdout.write(`${value.candidateId}\t${value.releaseId}\t${crypto.createHash('sha256').update(source).digest('hex')}\n`);
NODE
)"
IFS=$'\t' read -r authority_candidate_id authority_release_id deployment_authority_sha256 <<<"$authority_fields"
[[ "$authority_candidate_id" =~ ^[0-9a-f]{64}$ && "$authority_release_id" =~ ^[0-9a-f]{64}$ \
  && "$deployment_authority_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || die "hosted deployment authority returned invalid identities"
[[ -z "$candidate_id_arg" || "$candidate_id_arg" == "$authority_candidate_id" ]] \
  || die "hosted deployment authority selected a different candidate ID"
candidate_snapshot="$snapshot_dir/candidate-snapshot"
mkdir -m 700 "$candidate_snapshot"
(
  cd "$REVIVAL_ROOT"
  run_local_node --input-type=module - "$candidate_path" "$candidate_snapshot" "$candidate_id_arg" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import {
  assertLegacyProductionCompatible,
  assertReleaseProtocolManifestMatchesTrusted,
  EXPECTED_CANDIDATE_FILES,
  HOSTED_CANDIDATE_AUTHORITY,
  canonicalStringify,
  productionStateForSnapshot,
  verifyCandidate,
} from './platform/deploy/release-candidate.mjs';
const [source, destination, requestedId] = process.argv.slice(2);
const verified = verifyCandidate(source, {expectedId: requestedId, enforceTrustedProtocol: true});
if (path.basename(verified.root) !== verified.candidateId) throw new Error('candidate directory name does not match its internal candidate ID');
if (canonicalStringify(verified.authority) !== canonicalStringify(HOSTED_CANDIDATE_AUTHORITY)) {
  throw new Error('local candidate is candidate/debug-only and cannot be deployed');
}
const reviewedProductionState = productionStateForSnapshot(process.cwd());
assertLegacyProductionCompatible(reviewedProductionState);
if (canonicalStringify(verified.productionState) !== canonicalStringify(reviewedProductionState)) {
  throw new Error('candidate production-state differs from the freshly rederived reviewed source authority');
}
assertLegacyProductionCompatible(verified.productionState);
assertReleaseProtocolManifestMatchesTrusted(verified.manifest);
for (const name of EXPECTED_CANDIDATE_FILES) {
  fs.copyFileSync(path.join(verified.root, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(destination, name), 0o600);
}
const copied = verifyCandidate(destination, {expectedId: verified.candidateId, enforceTrustedProtocol: true});
assertLegacyProductionCompatible(copied.productionState);
process.stdout.write(`${copied.candidateId}\t${copied.release.releaseId}\n`);
NODE
) >"$snapshot_dir/identity.tsv"
IFS=$'\t' read -r candidate_id release_id <"$snapshot_dir/identity.tsv"
[[ "$candidate_id" =~ ^[0-9a-f]{64}$ ]] || die "verified candidate identity is invalid"
validate_release_id "$release_id"
[[ "$candidate_id" == "$authority_candidate_id" && "$release_id" == "$authority_release_id" ]] \
  || die "hosted provider evidence differs from the snapshotted candidate"
upload_root="$snapshot_dir/upload"
mkdir -m 700 "$upload_root"
mv -- "$candidate_snapshot" "$upload_root/$candidate_id"
candidate_snapshot="$upload_root/$candidate_id"
mv -- "$deployment_authority" "$upload_root/deployment-authority.json"
deployment_authority="$upload_root/deployment-authority.json"
[[ "$(local_sha256_file "$deployment_authority")" == "$deployment_authority_sha256" ]] \
  || die "hosted deployment authority moved after point-of-use verification"
archive="$candidate_snapshot/release.tar.gz"
manifest="$candidate_snapshot/release.manifest.json"

# Keep the established package verifier as an independent second binding.
verify_json="$snapshot_dir/verify.json"
(cd "$REVIVAL_ROOT" && run_local_node platform/deploy/release.mjs verify --archive "$archive" --manifest "$manifest" --json) >"$verify_json"
run_local_node - "$verify_json" "$release_id" <<'NODE'
const fs = require('node:fs');
const [file, expected] = process.argv.slice(2);
const match = fs.readFileSync(file, 'utf8').trim().match(/\{[\s\S]*\}\s*$/);
if (!match) process.exit(1);
const result = JSON.parse(match[0]);
if (result.ok !== true || result.profile !== 'vps' || result.releaseId !== expected) process.exit(1);
NODE
assert_release_bootstrap_contract "$manifest" "$release_id"
selected_verifier="$snapshot_dir/verify-release.py"
install -m 600 /dev/null "$selected_verifier"
materialize_release_member "$archive" "$manifest" "$release_id" "$RELEASE_VERIFIER_PATH" "$selected_verifier"
run_local_python -I -B "$selected_verifier" --archive "$archive" --manifest "$manifest" --expect-release-id "$release_id" --json >/dev/null
cmp -s "$selected_verifier" "$candidate_snapshot/verify-release.py" \
  || die "candidate verifier differs from the independently extracted release verifier"

# Fixed-name transport inventory. It is itself ACKed after sha256sum verifies
# every sealed candidate byte and the independently extracted verifier.
: >"$upload_root/transport.sha256"
printf '%s  %s\n' "$deployment_authority_sha256" deployment-authority.json >>"$upload_root/transport.sha256"
for transport_file in candidate.json compose-model.json image-receipt.json images.tar production-state.json \
  release.json release.manifest.json release.tar.gz source-commit.txt source-receipt.json source-snapshot.tar \
  toolchain-receipt.json verify-release.py; do
  printf '%s  %s/%s\n' "$(local_sha256_file "$candidate_snapshot/$transport_file")" "$candidate_id" "$transport_file" \
    >>"$upload_root/transport.sha256"
done
chmod 600 "$upload_root/transport.sha256"
transport_ack="$(local_sha256_file "$upload_root/transport.sha256")"
archive_bytes="$(stat -f '%z' "$archive" 2>/dev/null || stat -c '%s' "$archive")"
image_bytes="$(stat -f '%z' "$candidate_snapshot/images.tar" 2>/dev/null || stat -c '%s' "$candidate_snapshot/images.tar")"
total_bytes=$((archive_bytes + image_bytes))

if ((dry_run)); then
  ((cleanup == 0)) || usage_error "--cleanup-project-images is unavailable with --dry-run"
  if ((json)); then
    run_local_node - "$candidate_id" "$release_id" "$deploy_operation" <<'NODE'
const [candidateId,releaseId,operation]=process.argv.slice(2);
console.log(JSON.stringify({ok:true,dryRun:true,candidateId,releaseId,operation,remoteContacted:false}));
NODE
  else
    printf 'dry-run passed locally: operation=%s candidate=%s release=%s (remote not contacted)\n' \
      "$deploy_operation" "$candidate_id" "$release_id"
  fi
  exit 0
fi

local_preflight
start_remote_upload_lease
assert_remote_upload_lease
incoming="$REMOTE_ROOT/incoming/$release_id"
remote_preupload_gate "$release_id" "$min_free_gb" "$total_bytes" "$incoming"
partial="$incoming/.candidate-${candidate_id}.partial"
final="$partial/$candidate_id"
remote_upload_args="$(remote_quote "$REMOTE_ROOT" "$incoming" "$partial" "$release_id" "$candidate_id")"
run_ssh "$REMOTE_CLEAN_PYTHON - $remote_upload_args" <<'PY'
import os,stat,sys
root,incoming,partial,release_id,candidate_id=sys.argv[1:]
uid=os.getuid(); gid=os.getgid()
assert root=="/home/anders/ai-pin-revival"
assert incoming==f"{root}/incoming/{release_id}"
assert partial==f"{incoming}/.candidate-{candidate_id}.partial"
assert len(release_id)==len(candidate_id)==64 and all(c in "0123456789abcdef" for c in release_id+candidate_id)
for ancestor in ("/home","/home/anders"):
    metadata=os.lstat(ancestor)
    assert stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
def ensure(path):
    try: os.mkdir(path,0o700)
    except FileExistsError: pass
    metadata=os.lstat(path)
    assert stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode)
    assert stat.S_IMODE(metadata.st_mode)==0o700 and (metadata.st_uid,metadata.st_gid)==(uid,gid)
for path in (root,f"{root}/incoming"):
    ensure(path)
assert not os.path.lexists(incoming)
os.mkdir(incoming,0o700)
os.mkdir(partial,0o700)
for directory in (f"{root}/incoming",incoming,partial):
    descriptor=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    os.fsync(descriptor); os.close(descriptor)
PY
transfer_candidate_resumably "$upload_root" "$partial" "$transport_ack"
assert_remote_upload_lease

deployment_id="$(date -u +%Y%m%dT%H%M%SZ)-${release_id:0:12}"
deployment_status=0
run_verified_release_deploy \
  "$release_id" "$incoming" "$final/release.tar.gz" "$final/release.manifest.json" \
  "$final/verify-release.py" "$deployment_id" "$min_free_gb" "$total_bytes" "$cleanup" "$json" \
  "$skip_smoke" "$candidate_id" "$final" "$deployment_authority_sha256" \
  "$deploy_operation" || deployment_status=$?
stop_remote_upload_lease || deployment_status=1
exit "$deployment_status"
