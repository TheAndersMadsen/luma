#!/usr/bin/bash
set -euo pipefail
source "${REVIVAL_HELD_COMMON:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/common.sh}"

candidate_id=""
candidate_root=""
release_id=""
deployment_authority=""
deployment_authority_sha256=""
json=0
usage() {
  echo "usage: register-legacy-predecessor --candidate-id SHA256 --candidate-root PATH --release-id SHA256 --deployment-authority PATH --deployment-authority-sha256 SHA256 [--json]" >&2
  exit 64
}
while (($#)); do
  case "$1" in
    --candidate-id) (($# >= 2)) || usage; candidate_id="$2"; shift 2 ;;
    --candidate-root) (($# >= 2)) || usage; candidate_root="$2"; shift 2 ;;
    --release-id) (($# >= 2)) || usage; release_id="$2"; shift 2 ;;
    --deployment-authority) (($# >= 2)) || usage; deployment_authority="$2"; shift 2 ;;
    --deployment-authority-sha256) (($# >= 2)) || usage; deployment_authority_sha256="$2"; shift 2 ;;
    --json) json=1; shift ;;
    *) usage ;;
  esac
done
[[ "$candidate_id" =~ ^[0-9a-f]{64}$ && "$release_id" =~ ^[0-9a-f]{64}$ \
  && "$deployment_authority_sha256" =~ ^[0-9a-f]{64}$ \
  && "$candidate_root" == "$REMOTE_ROOT/incoming/$release_id/.candidate-$candidate_id.partial/$candidate_id" \
  && "$deployment_authority" == "$REMOTE_ROOT/incoming/$release_id/.candidate-$candidate_id.partial/deployment-authority.json" ]] \
  || usage

assert_target
assert_remote_root
for command in docker flock python3 node sha256sum cmp stat readlink curl systemctl find awk; do need "$command"; done
[[ "${REVIVAL_HELD_RELEASE_ID:-}" == "$release_id" \
  && "${REVIVAL_HELD_RELEASE_LOGICAL_ROOT:-}" == "$REMOTE_ROOT/incoming/$release_id/verified-driver" \
  && "${REVIVAL_HELD_EXEC:-}" =~ ^/proc/self/fd/[1-9][0-9]*$ ]] \
  || fail "legacy predecessor registrar is not the selected candidate's held release"
[[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock \
  && "${DOCKER_CONFIG:-}" == "$PRIVATE_DIR/docker-cli-empty" \
  && -d "$DOCKER_CONFIG" && ! -L "$DOCKER_CONFIG" \
  && -z "$(find "$DOCKER_CONFIG" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
  || fail "legacy predecessor registrar Docker authority is not the fixed empty local configuration"

candidate_verification="$(run_held_candidate_verifier verify --candidate "$candidate_root" \
  --expect-id "$candidate_id" --json)" \
  || fail "legacy predecessor registrar candidate failed held filesystem verification"
node -e 'const v=JSON.parse(process.argv[1]);if(v.ok!==true||v.candidateId!==process.argv[2]||v.releaseId!==process.argv[3]||v.productionCompatible!==true||v.authority?.origin!=="github-hosted-actions")process.exit(1)' \
  "$candidate_verification" "$candidate_id" "$release_id" \
  || fail "legacy predecessor registrar candidate is not the selected hosted compatible release"
[[ -f "$deployment_authority" && ! -L "$deployment_authority" \
  && "$(stat -c '%a:%u:%g:%h' "$deployment_authority")" == "600:$(id -u):$(id -g):1" \
  && "$(sha256sum "$deployment_authority" | awk '{print $1}')" == "$deployment_authority_sha256" ]] \
  || fail "legacy predecessor registrar deployment authority is unsafe or changed"
python3 - "$deployment_authority" "$candidate_id" "$release_id" "$deployment_authority_sha256" <<'PY' \
  || fail "legacy predecessor registrar lacks exact point-of-use provider evidence"
import hashlib,json,os,re,stat,sys
path,candidate_id,release_id,expected_sha=sys.argv[1:]
before=os.lstat(path)
assert stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode) and before.st_nlink==1
assert (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))==(os.getuid(),os.getgid(),0o600)
descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
try:
    opened=os.fstat(descriptor); assert opened==before and 0<opened.st_size<=1024*1024
    payload=bytearray()
    while len(payload)<opened.st_size:
        block=os.pread(descriptor,min(1024*1024,opened.st_size-len(payload)),len(payload)); assert block
        payload.extend(block)
    assert os.fstat(descriptor)==opened and os.lstat(path)==before
finally: os.close(descriptor)
payload=bytes(payload); assert hashlib.sha256(payload).hexdigest()==expected_sha
source=payload.decode(); value=json.loads(source)
canonical=json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False)+"\n"
fields={"schema","version","ok","candidateId","releaseId","sourceDigest","sourceTree","sourceArchiveSha256",
        "repository","sourceRef","runnerInvocationUri","candidateRoot","evidenceRoot","inventorySha256",
        "receiptSha256","providerBundleSha256","verificationSha256","evidenceSha256","manifestSha256","providerEvidence"}
assert source==canonical and set(value)==fields
assert value["schema"]=="revival.hosted-vps-candidate-authority" and value["version"]==1 and value["ok"] is True
assert value["candidateId"]==candidate_id and value["releaseId"]==release_id
assert value["providerEvidence"]=="point-of-use-reverified"
assert value["repository"]=="TheAndersMadsen/ai-pin-revival" and value["sourceRef"]=="refs/heads/main"
assert re.fullmatch(r"https://github\.com/TheAndersMadsen/ai-pin-revival/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*",value["runnerInvocationUri"])
PY

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another deployment or backup holds the lock"

transaction_driver="${REVIVAL_HELD_TRANSACTION:-}"
release_material_file_is_safe "$transaction_driver" \
  || fail "legacy predecessor registrar transaction inventory authority is unavailable"
inventory="$(python3 "$transaction_driver" --root "$REMOTE_ROOT" --inventory)" \
  || fail "legacy predecessor registrar could not inspect global transaction authority"
python3 - "$inventory" <<'PY' \
  || fail "legacy predecessor registrar refuses while any authority transaction is pending"
import json,sys
value=json.loads(sys.argv[1])
assert value.get("schemaVersion")==1 and value.get("active")==[]
PY
for pointer in current previous current-deployment; do
  [[ ! -e "$REMOTE_ROOT/$pointer" && ! -L "$REMOTE_ROOT/$pointer" ]] \
    || fail "legacy predecessor registrar refuses an existing canonical release pointer: $pointer"
done
assert_durable_inputs
assert_active_durable_mounts

work="$(mktemp -d)"
chmod 700 "$work"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
first="$work/observation.first.json"
second="$work/observation.second.json"
assert_active_durable_mounts
capture_legacy_predecessor_observation "$first" active
assert_active_durable_mounts
capture_legacy_predecessor_observation "$second" active
cmp -s "$first" "$second" \
  || fail "live legacy runtime changed while its rollback observation was captured"
assert_active_durable_mounts
predecessor_id="$(register_legacy_predecessor "$second" "$candidate_id" "$release_id" \
  "$deployment_authority_sha256")" \
  || fail "adopted legacy predecessor authority could not be sealed"
[[ "$predecessor_id" =~ ^[0-9a-f]{64}$ \
  && "$(active_legacy_predecessor_id)" == "$predecessor_id" ]] \
  || fail "sealed adopted legacy predecessor authority is not active"

if ((json)); then
  python3 - "$predecessor_id" "$candidate_id" "$release_id" <<'PY'
import json,sys
print(json.dumps({"ok":True,"authorityKind":"adopted-live-carry-v1","baselineId":sys.argv[1],
                  "registrarCandidateId":sys.argv[2],"registrarReleaseId":sys.argv[3],
                  "runtimeMutated":False,"runtimeProvenance":"observed-live-runtime-not-provider-built"},
                 sort_keys=True,separators=(",",":")))
PY
else
  log "registered adopted-live-carry-v1 predecessor $predecessor_id without changing the live runtime"
fi
