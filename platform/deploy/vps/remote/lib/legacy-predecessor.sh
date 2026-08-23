#!/usr/bin/bash
# One-time legacy predecessor authority. A hosted release proves this
# registrar/checker, never the provenance of the pre-workflow image bytes it
# observes.

legacy_predecessor_program() {
  local program="${REVIVAL_HELD_LEGACY_PREDECESSOR:-}"
  [[ "$program" =~ ^/proc/self/fd/[1-9][0-9]*$ ]] \
    || fail "held legacy predecessor registrar authority is unavailable"
  release_material_file_is_safe "$program" \
    || fail "legacy predecessor registrar is not one sealed release object"
  python3 "$program" "$@"
}

# The deployed edge and PKI trees deliberately belong to their container
# identities (1000:1001 and 65532:65532), not to the deployment account.  A
# normal read cannot open their mode-0600 keys.  This fixed held helper runs
# read-only through the existing positive-environment sudo allowlist and emits
# only inode/metadata/content digests; private key bytes never cross stdout or
# enter the adopted record.
write_exact_legacy_security_identity() {
  sudo -n python3 - <<'PY'
import hashlib,json,os,stat

MAX_MEMBERS=10_000
MAX_BYTES=256*1024*1024
ROOTS={
    "edge":("/home/anders/carry-edge",1000,1001),
    "attestation-pki":("/home/anders/carry-attest",65532,65532),
    "device-user-pki":("/home/anders/carry-duc",65532,65532),
}
REQUIRED={
    "edge":{"envoy.yaml","certs/server.crt","certs/server.key",
            "certs/api-client-ca.crt","certs/onboarding-client-ca.crt"},
    "attestation-pki":{"ca.crt","ca.key"},
    "device-user-pki":{"duc-ca.crt","duc-ca.key"},
}

def identity(value):
    return {
        "device":value.st_dev,"inode":value.st_ino,"mode":stat.S_IMODE(value.st_mode),
        "uid":value.st_uid,"gid":value.st_gid,"links":value.st_nlink,"size":value.st_size,
        "mtimeNs":value.st_mtime_ns,"ctimeNs":value.st_ctime_ns,
    }

def open_absolute_directory(path):
    assert path.startswith("/") and os.path.normpath(path)==path and os.path.realpath(path)==path
    descriptor=os.open("/",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        walked=""
        for component in path.split("/")[1:]:
            assert component and component not in {".",".."}
            before=os.stat(component,dir_fd=descriptor,follow_symlinks=False)
            assert stat.S_ISDIR(before.st_mode) and not stat.S_ISLNK(before.st_mode)
            child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
            opened=os.fstat(child)
            assert identity(opened)==identity(before)
            os.close(descriptor); descriptor=child; walked+="/"+component
            if walked=="/home":
                assert (opened.st_uid,opened.st_gid)==(0,0) and not (stat.S_IMODE(opened.st_mode)&0o022)
            elif walked=="/home/anders":
                assert opened.st_uid==1000 and not (stat.S_IMODE(opened.st_mode)&0o022)
        return descriptor
    except BaseException:
        os.close(descriptor); raise

def inventory(name,path,expected_uid,expected_gid):
    assert os.path.isabs(path) and os.path.realpath(path)==path
    root=os.lstat(path)
    assert stat.S_ISDIR(root.st_mode) and not stat.S_ISLNK(root.st_mode)
    entries=[]; total=0
    def check(metadata):
        assert (metadata.st_uid,metadata.st_gid)==(expected_uid,expected_gid)
        assert not stat.S_ISLNK(metadata.st_mode) and not (stat.S_IMODE(metadata.st_mode)&0o022)
    def walk(descriptor,relative,opened):
        nonlocal total
        check(opened)
        entries.append({"path":relative,"kind":"directory",**identity(opened)})
        names=sorted(os.listdir(descriptor))
        for name in names:
            assert name not in {"",".",".."} and "/" not in name
            before=os.stat(name,dir_fd=descriptor,follow_symlinks=False); check(before)
            child_relative=name if relative=="." else relative+"/"+name
            if stat.S_ISDIR(before.st_mode):
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
                try:
                    child_opened=os.fstat(child); assert identity(child_opened)==identity(before)
                    walk(child,child_relative,child_opened)
                    assert identity(os.fstat(child))==identity(child_opened)
                    assert identity(os.stat(name,dir_fd=descriptor,follow_symlinks=False))==identity(before)
                finally: os.close(child)
            elif stat.S_ISREG(before.st_mode):
                assert before.st_nlink==1
                child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=descriptor)
                try:
                    child_opened=os.fstat(child); assert identity(child_opened)==identity(before)
                    total+=child_opened.st_size; assert total<=MAX_BYTES
                    digest=hashlib.sha256(); offset=0
                    while offset<child_opened.st_size:
                        block=os.pread(child,min(1024*1024,child_opened.st_size-offset),offset); assert block
                        digest.update(block); offset+=len(block)
                    assert identity(os.fstat(child))==identity(child_opened)
                    assert identity(os.stat(name,dir_fd=descriptor,follow_symlinks=False))==identity(before)
                    entries.append({"path":child_relative,"kind":"file",**identity(before),
                                    "sha256":digest.hexdigest()})
                finally: os.close(child)
            else: raise SystemExit("unsupported privileged legacy configuration object")
            assert len(entries)<=MAX_MEMBERS
        assert sorted(os.listdir(descriptor))==names
        assert identity(os.fstat(descriptor))==identity(opened)
    descriptor=open_absolute_directory(path)
    try:
        opened=os.fstat(descriptor); assert identity(opened)==identity(root)
        walk(descriptor,".",opened)
        assert identity(os.fstat(descriptor))==identity(opened)
        assert identity(os.lstat(path))==identity(root)
    finally: os.close(descriptor)
    entries.sort(key=lambda item:(item["path"]!=".",item["path"]))
    files={item["path"] for item in entries if item["kind"]=="file"}
    assert REQUIRED[name] <= files
    return {"root":path,"entries":entries}

result={name:inventory(name,path,uid,gid) for name,(path,uid,gid) in ROOTS.items()}
print(json.dumps(result,sort_keys=True,separators=(",",":"),ensure_ascii=False))
PY
}

# Shared by the predecessor capture and every forward/rollback gate so they
# compare the exact same inode/content/metadata closure.
write_privileged_legacy_configuration_inventory() {
  write_exact_legacy_security_identity
}

record_exact_legacy_security_identity() {
  local output="$1"
  [[ ! -e "$output" && ! -L "$output" ]] \
    || fail "legacy security identity output already exists"
  write_exact_legacy_security_identity >"$output" \
    || { rm -f -- "$output"; fail "exact legacy security paths are missing, aliased, writable, unowned, or unstable"; }
  chmod 600 "$output"
  [[ -f "$output" && ! -L "$output" \
    && "$(stat -c '%a:%u:%g:%h' "$output")" == "600:$(id -u):$(id -g):1" ]] \
    || fail "legacy security identity evidence is unsafe"
}

verify_exact_legacy_security_identity() {
  local expected="$1" current status=0
  current="$(mktemp)" || fail "could not allocate legacy security verification workspace"
  write_exact_legacy_security_identity >"$current" || status=$?
  if ((status == 0)); then
    python3 - "$expected" "$current" <<'PY' || status=$?
import os,stat,sys

expected,current=sys.argv[1:]
uid=os.getuid(); gid=os.getgid()

def identity(value):
    return (value.st_dev,value.st_ino,stat.S_IFMT(value.st_mode),stat.S_IMODE(value.st_mode),
            value.st_uid,value.st_gid,value.st_nlink,value.st_size,value.st_mtime_ns,value.st_ctime_ns)

def read_stable(path):
    before=os.lstat(path)
    assert stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode)
    assert (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode),before.st_nlink)==(uid,gid,0o600,1)
    assert 0<before.st_size<=64*1024*1024 and os.path.isabs(path) and os.path.normpath(path)==path
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        opened=os.fstat(descriptor); assert identity(opened)==identity(before)
        payload=bytearray(); offset=0
        while offset<opened.st_size:
            block=os.pread(descriptor,min(1024*1024,opened.st_size-offset),offset); assert block
            payload.extend(block); offset+=len(block)
        assert identity(os.fstat(descriptor))==identity(opened)
        assert identity(os.lstat(path))==identity(before)
        return bytes(payload)
    finally: os.close(descriptor)

assert read_stable(expected)==read_stable(current)
PY
  fi
  rm -f -- "$current" || status=1
  ((status == 0)) \
    || fail "legacy PKI/certificate path inode, metadata, or content identity changed"
}

capture_legacy_predecessor_observation() {
  local output="$1" expected_state="$2" canonical_expectation="${3:-present}"
  local canonical_ids legacy_output work semantic container status=0
  local -a legacy_ids=()
  [[ "$expected_state" == active || "$expected_state" == stopped ]] \
    || fail "unsupported legacy predecessor observation state"
  [[ ! -e "$output" && ! -L "$output" ]] \
    || fail "legacy predecessor observation output already exists"

  canonical_ids="$(docker ps -a --no-trunc -q \
    --filter "label=com.docker.compose.project=$PROJECT")" \
    || fail "canonical project inventory failed"
  if [[ "$expected_state" == active ]]; then
    [[ -z "$canonical_ids" ]] \
      || fail "canonical project exists while the legacy predecessor is authoritative"
  else
    case "$canonical_expectation" in
      present)
        [[ -n "$canonical_ids" ]] \
          || fail "stopped legacy predecessor identity is only admissible beside its immediate canonical first-cutover successor"
        ;;
      absent)
        [[ -z "$canonical_ids" ]] \
          || fail "canonical containers still exist at the legacy activation boundary"
        ;;
      *) fail "invalid canonical topology expectation for stopped legacy predecessor verification" ;;
    esac
  fi
  legacy_output="$(docker ps -a --no-trunc -q \
    --filter "label=com.docker.compose.project=$LEGACY_PROJECT")" \
    || fail "legacy project inventory failed"
  while IFS= read -r container; do
    [[ -z "$container" ]] || legacy_ids+=("$container")
  done <<<"$legacy_output"
  ((${#legacy_ids[@]} == 15)) \
    || fail "legacy project does not contain the exact required container count"
  for container in "${legacy_ids[@]}"; do
    [[ "$container" =~ ^[0-9a-f]{64}$ ]] \
      || fail "legacy project returned a truncated or invalid container identity"
  done

  work="$(mktemp -d)" || fail "could not create private legacy predecessor observation workspace"
  chmod 700 "$work"
  semantic="$work/semantic.tsv"
  if [[ "$expected_state" == active ]]; then
    write_legacy_semantic_evidence "$semantic" || status=$?
  fi
  if ((status == 0)); then
    if [[ "$expected_state" == active ]]; then
      legacy_predecessor_program capture --state active \
        --containers-fd 3 --volumes-fd 4 --networks-fd 5 \
        --privileged-config-fd 6 --semantic "$semantic" --output "$output" \
        3< <(docker inspect "${legacy_ids[@]}") \
        4< <(docker volume inspect "$STATE_VOLUME" "$PG_VOLUME" "$PROMETHEUS_VOLUME" "$GRAFANA_VOLUME") \
        5< <(docker network inspect "$LOCAL_MODEL_NETWORK" carry-net) \
        6< <(write_privileged_legacy_configuration_inventory) || status=$?
    else
      legacy_predecessor_program capture --state stopped \
        --containers-fd 3 --volumes-fd 4 --networks-fd 5 --privileged-config-fd 6 --output "$output" \
        3< <(docker inspect "${legacy_ids[@]}") \
        4< <(docker volume inspect "$STATE_VOLUME" "$PG_VOLUME" "$PROMETHEUS_VOLUME" "$GRAFANA_VOLUME") \
        5< <(docker network inspect "$LOCAL_MODEL_NETWORK" carry-net) \
        6< <(write_privileged_legacy_configuration_inventory) || status=$?
    fi
  fi
  rm -rf -- "$work" || status=1
  if ((status != 0)); then
    rm -f -- "$output"
    return "$status"
  fi
  [[ -f "$output" && ! -L "$output" \
    && "$(stat -c '%a:%u:%g:%h' "$output")" == "600:$(id -u):$(id -g):1" ]] \
    || fail "legacy predecessor observation output is unsafe"
}

active_legacy_predecessor_id() {
  legacy_predecessor_program active-id --root "$REMOTE_ROOT"
}

register_legacy_predecessor() {
  local observation="$1" candidate_id="$2" release_id="$3" authority_sha256="$4"
  legacy_predecessor_program register --root "$REMOTE_ROOT" --observation "$observation" \
    --candidate-id "$candidate_id" --release-id "$release_id" \
    --deployment-authority-sha256 "$authority_sha256"
}

verify_legacy_predecessor() {
  local predecessor_id="$1" state="$2" candidate_id="${3:-}" release_id="${4:-}" authority_sha256="${5:-}"
  local canonical_expectation="${6:-present}"
  local work current status=0
  local -a arguments=()
  work="$(mktemp -d)" || fail "could not create private legacy predecessor verification workspace"
  chmod 700 "$work"
  current="$work/current.json"
  capture_legacy_predecessor_observation "$current" "$state" "$canonical_expectation" || status=$?
  if ((status == 0)); then
    arguments=(verify --root "$REMOTE_ROOT" --predecessor-id "$predecessor_id" \
      --current "$current" --state "$state")
    [[ -z "$candidate_id" ]] || arguments+=(--candidate-id "$candidate_id")
    [[ -z "$release_id" ]] || arguments+=(--release-id "$release_id")
    [[ -z "$authority_sha256" ]] || arguments+=(--deployment-authority-sha256 "$authority_sha256")
    legacy_predecessor_program "${arguments[@]}" >/dev/null || status=$?
  fi
  rm -rf -- "$work" || status=1
  return "$status"
}
